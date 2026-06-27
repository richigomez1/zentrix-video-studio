/* ═══════════════════════════════════════════════════════════
   Export Worker v2 — Fast concat for pre-normalized clips
   Falls back to per-clip normalization for legacy clips.
   ═══════════════════════════════════════════════════════════ */

import { FFmpeg } from "@ffmpeg/ffmpeg"
import { toBlobURL } from "@ffmpeg/util"

/* ── Types ── */
interface VideoMeta {
  fps: number
  width: number
  height: number
  codec_v: string
  codec_a: string
  has_audio: boolean
}

interface SceneClip {
  index: number
  videoUrl: string
  duration: number
  volume: number
  meta?: VideoMeta | null
}

interface StartMessage {
  type: "start"
  clips: SceneClip[]
  resolution: "720p" | "1080p"
  audioUrls: string[]
}

interface CancelMessage {
  type: "cancel"
}

type WorkerMessage = StartMessage | CancelMessage

const TARGET_FPS = 30

let ffmpeg: FFmpeg | null = null
let cancelled = false
let lastError = ""

/* ── Send progress to main thread ── */
function sendProgress(phase: string, progress: number, status: string) {
  self.postMessage({ type: "progress", phase, progress, status })
}

/* ── Load FFmpeg.wasm ── */
async function loadFFmpegWorker(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg
  const ff = new FFmpeg()
  ff.on("log", ({ message }) => {
    if (message.toLowerCase().includes("error") || message.toLowerCase().includes("invalid")) {
      lastError = message
    }
  })
  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd"
  await ff.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  })
  ffmpeg = ff
  return ff
}

/* ── Check if a clip is export-ready (matches target format) ── */
function isExportReady(meta: VideoMeta | null | undefined, tw: number, th: number): boolean {
  if (!meta) return false
  const fpsOk = Math.abs(meta.fps - TARGET_FPS) < 1.0
  const resOk = meta.width === tw && meta.height === th
  const codecOk = meta.codec_v === "h264"
  const audioOk = meta.has_audio && meta.codec_a === "aac"
  return fpsOk && resOk && codecOk && audioOk
}

/* ── FAST PATH: all clips are pre-normalized → just concat ── */
async function runFastExport(ff: FFmpeg, clips: SceneClip[], audioUrls: string[]) {
  // Download all clips
  for (let i = 0; i < clips.length; i++) {
    if (cancelled) return
    sendProgress("processing", Math.round((i / clips.length) * 90), `Descargando clip ${i + 1} de ${clips.length}...`)

    const response = await fetch(clips[i].videoUrl)
    if (!response.ok) throw new Error(`Error descargando clip ${i + 1}: HTTP ${response.status}`)
    const data = new Uint8Array(await response.arrayBuffer())
    await ff.writeFile(`clip_${i}.mp4`, data)
  }

  if (cancelled) return

  // Concat with stream copy (instant — no re-encoding)
  sendProgress("finalizing", 92, "Uniendo clips (rápido)...")

  let concatList = ""
  for (let i = 0; i < clips.length; i++) {
    concatList += `file 'clip_${i}.mp4'\n`
  }
  const encoder = new TextEncoder()
  await ff.writeFile("concat.txt", encoder.encode(concatList))

  await ff.exec([
    "-f", "concat", "-safe", "0", "-i", "concat.txt",
    "-c", "copy",
    "-movflags", "+faststart",
    "-y", "output.mp4",
  ])

  // Cleanup
  for (let i = 0; i < clips.length; i++) {
    try { await ff.deleteFile(`clip_${i}.mp4`) } catch {}
  }
  try { await ff.deleteFile("concat.txt") } catch {}
}

/* ── SLOW PATH: normalize clips that aren't export-ready ── */
async function runLegacyExport(ff: FFmpeg, clips: SceneClip[], resolution: "720p" | "1080p") {
  const tw = resolution === "1080p" ? 1920 : 1280
  const th = resolution === "1080p" ? 1080 : 720

  for (let i = 0; i < clips.length; i++) {
    if (cancelled) return
    sendProgress("processing", Math.round((i / clips.length) * 90), `Clip ${i + 1} de ${clips.length} — descargando...`)

    const response = await fetch(clips[i].videoUrl)
    if (!response.ok) throw new Error(`Error descargando clip ${i + 1}: HTTP ${response.status}`)
    const data = new Uint8Array(await response.arrayBuffer())
    await ff.writeFile(`input_${i}.mp4`, data)

    // Check if this specific clip needs normalization
    if (isExportReady(clips[i].meta, tw, th)) {
      // This clip is already good — just rename
      sendProgress("processing", Math.round((i / clips.length) * 90), `Clip ${i + 1} de ${clips.length} — listo ✓`)
      // Read and rewrite (ffmpeg.wasm has no rename)
      const ready = await ff.readFile(`input_${i}.mp4`)
      await ff.writeFile(`clip_${i}.mp4`, ready)
      try { await ff.deleteFile(`input_${i}.mp4`) } catch {}
      continue
    }

    // Needs normalization
    sendProgress("processing", Math.round((i / clips.length) * 90), `Clip ${i + 1} de ${clips.length} — normalizando...`)

    const vol = clips[i].volume / 100
    const vf = [
      `fps=${TARGET_FPS}`,
      `scale=${tw}:${th}:force_original_aspect_ratio=decrease`,
      `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2`,
      `setsar=1`,
    ].join(",")

    const af = `volume=${vol.toFixed(2)}`

    // Try with audio
    let ok = false
    try {
      await ff.exec([
        "-i", `input_${i}.mp4`,
        "-vf", vf,
        "-af", af,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-r", String(TARGET_FPS),
        "-y", `clip_${i}.mp4`,
      ])
      const check = await ff.readFile(`clip_${i}.mp4`)
      if (check.length > 500) ok = true
    } catch { ok = false }

    if (!ok) {
      // No audio — add silent track
      try {
        await ff.exec([
          "-i", `input_${i}.mp4`,
          "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
          "-vf", vf,
          "-map", "0:v", "-map", "1:a",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
          "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
          "-r", String(TARGET_FPS),
          "-shortest",
          "-y", `clip_${i}.mp4`,
        ])
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2)
        throw new Error(`Clip ${i + 1} falló: ${msg}. FFmpeg: ${lastError}`)
      }
    }

    try { await ff.deleteFile(`input_${i}.mp4`) } catch {}
  }

  if (cancelled) return

  // Concat
  sendProgress("finalizing", 92, "Uniendo clips...")

  let concatList = ""
  for (let i = 0; i < clips.length; i++) {
    concatList += `file 'clip_${i}.mp4'\n`
  }
  const encoder = new TextEncoder()
  await ff.writeFile("concat.txt", encoder.encode(concatList))

  await ff.exec([
    "-f", "concat", "-safe", "0", "-i", "concat.txt",
    "-c", "copy",
    "-movflags", "+faststart",
    "-y", "output.mp4",
  ])

  for (let i = 0; i < clips.length; i++) {
    try { await ff.deleteFile(`clip_${i}.mp4`) } catch {}
  }
  try { await ff.deleteFile("concat.txt") } catch {}
}

/* ── Mix narration audio ── */
async function mixNarration(ff: FFmpeg, audioUrls: string[]) {
  if (!audioUrls || audioUrls.length === 0) return

  sendProgress("finalizing", 93, "Descargando narración...")

  const narrationUrl = audioUrls[0]
  const narResponse = await fetch(narrationUrl)
  if (!narResponse.ok) throw new Error(`Error descargando narración: HTTP ${narResponse.status}`)
  const narData = new Uint8Array(await narResponse.arrayBuffer())

  const ext = narrationUrl.split(".").pop()?.split("?")[0] || "mp3"
  await ff.writeFile(`narration.${ext}`, narData)

  if (cancelled) return

  sendProgress("finalizing", 95, "Mezclando narración...")

  const concatData = await ff.readFile("output.mp4")
  await ff.writeFile("video_only.mp4", concatData)
  try { await ff.deleteFile("output.mp4") } catch {}

  try {
    await ff.exec([
      "-i", "video_only.mp4",
      "-i", `narration.${ext}`,
      "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]",
      "-map", "0:v", "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      "-y", "output.mp4",
    ])
  } catch {
    // Fallback: narration as sole audio
    await ff.exec([
      "-i", "video_only.mp4",
      "-i", `narration.${ext}`,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      "-y", "output.mp4",
    ])
  }

  try { await ff.deleteFile("video_only.mp4") } catch {}
  try { await ff.deleteFile(`narration.${ext}`) } catch {}
}

/* ── Main export function ── */
async function runExport(clips: SceneClip[], resolution: "720p" | "1080p", audioUrls: string[]) {
  cancelled = false
  lastError = ""

  sendProgress("loading", 0, "Preparando...")
  const ff = await loadFFmpegWorker()
  if (cancelled) return

  const tw = resolution === "1080p" ? 1920 : 1280
  const th = resolution === "1080p" ? 1080 : 720

  // Check how many clips are export-ready
  const readyCount = clips.filter(c => isExportReady(c.meta, tw, th)).length
  const allReady = readyCount === clips.length

  if (allReady) {
    sendProgress("processing", 5, `${clips.length} clips pre-normalizados — export rápido`)
    await runFastExport(ff, clips, audioUrls)
  } else {
    sendProgress("processing", 5, `${readyCount}/${clips.length} listos — normalizando ${clips.length - readyCount} clips...`)
    await runLegacyExport(ff, clips, resolution)
  }

  if (cancelled) return

  // Mix narration
  await mixNarration(ff, audioUrls)
  if (cancelled) return

  // ── Verify + send result ──
  sendProgress("finalizing", 98, "Verificando...")

  const outputData = await ff.readFile("output.mp4")
  if (outputData.length < 10000) {
    throw new Error(`Archivo muy pequeño (${(outputData.length / 1024).toFixed(0)} KB). FFmpeg: ${lastError}`)
  }
  try { await ff.deleteFile("output.mp4") } catch {}

  const totalMB = (outputData.length / 1024 / 1024).toFixed(1)

  // Transfer the buffer (zero-copy) to main thread
  const buffer = (outputData as Uint8Array).buffer
  self.postMessage(
    { type: "done", buffer, totalMB, clipCount: clips.length },
    [buffer]
  )
}

/* ── Message handler ── */
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data
  if (msg.type === "start") {
    try {
      await runExport(msg.clips, msg.resolution, msg.audioUrls)
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : `Error desconocido. FFmpeg: ${lastError}`
      self.postMessage({ type: "error", error: errMsg })
    }
  } else if (msg.type === "cancel") {
    cancelled = true
  }
}
