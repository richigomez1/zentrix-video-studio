/* ═══════════════════════════════════════════════════════════
   Export Worker — runs FFmpeg.wasm in a background thread
   so the main UI stays responsive during export.
   ═══════════════════════════════════════════════════════════ */

import { FFmpeg } from "@ffmpeg/ffmpeg"
import { toBlobURL } from "@ffmpeg/util"

/* ── Types ── */
interface SceneClip {
  index: number
  videoUrl: string
  duration: number
  volume: number
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
const FADE_DURATION = 0.7

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

/* ── Probe real duration of a file in ffmpeg's virtual FS ── */
async function probeDuration(ff: FFmpeg, filename: string, fallback: number): Promise<number> {
  let durationLine = ""
  const handler = ({ message }: { message: string }) => {
    // FFmpeg logs: "  Duration: 00:00:08.33, start: 0.000000, bitrate: ..."
    if (message.includes("Duration:")) {
      durationLine = message
    }
  }
  ff.on("log", handler)
  try {
    // Run ffmpeg -i (no output) — it "fails" but still logs the header info
    await ff.exec(["-i", filename, "-f", "null", "-"])
  } catch {
    // Expected to fail or succeed depending on version — either way the log fires
  }
  ff.off("log", handler)

  // Parse "Duration: HH:MM:SS.xx"
  const match = durationLine.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
  if (match) {
    const hours = parseInt(match[1], 10)
    const minutes = parseInt(match[2], 10)
    const seconds = parseFloat(match[3])
    const real = hours * 3600 + minutes * 60 + seconds
    if (real > 0) return real
  }
  // If probe failed, fall back to API duration
  return fallback
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

  // ── Download + Process each clip ──
  for (let i = 0; i < clips.length; i++) {
    if (cancelled) return
    sendProgress("processing", Math.round((i / clips.length) * 95), `Clip ${i + 1} de ${clips.length} — descargando...`)

    // Download
    const response = await fetch(clips[i].videoUrl)
    if (!response.ok) throw new Error(`Error descargando clip ${i + 1}: HTTP ${response.status}`)
    const data = new Uint8Array(await response.arrayBuffer())
    await ff.writeFile(`input_${i}.mp4`, data)

    // Probe real duration (fixes black screen between transitions)
    sendProgress("processing", Math.round((i / clips.length) * 95), `Clip ${i + 1} de ${clips.length} — analizando...`)
    const realDuration = await probeDuration(ff, `input_${i}.mp4`, clips[i].duration)

    // Normalize with fade
    sendProgress("processing", Math.round((i / clips.length) * 95), `Clip ${i + 1} de ${clips.length} — procesando...`)

    const vol = clips[i].volume / 100
    const clipDur = realDuration  // ← USE REAL DURATION, not API duration
    const isFirst = i === 0
    const isLast = i === clips.length - 1

    const vfParts = [
      `fps=${TARGET_FPS}`,
      `scale=${tw}:${th}:force_original_aspect_ratio=decrease`,
      `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2`,
      `setsar=1`,
    ]
    if (!isFirst) vfParts.push(`fade=t=in:st=0:d=${FADE_DURATION}`)
    if (!isLast) {
      const fadeOutStart = Math.max(0, clipDur - FADE_DURATION)
      vfParts.push(`fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${FADE_DURATION}`)
    }

    let af = `volume=${vol.toFixed(2)}`
    if (!isFirst) af += `,afade=t=in:st=0:d=${FADE_DURATION}`
    if (!isLast) {
      const aFadeOutStart = Math.max(0, clipDur - FADE_DURATION)
      af += `,afade=t=out:st=${aFadeOutStart.toFixed(2)}:d=${FADE_DURATION}`
    }

    // Try with audio
    let ok = false
    try {
      await ff.exec([
        "-i", `input_${i}.mp4`,
        "-vf", vfParts.join(","),
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
          "-vf", vfParts.join(","),
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

    // Free input
    try { await ff.deleteFile(`input_${i}.mp4`) } catch {}
  }

  if (cancelled) return

  // ── Concat (instant — stream copy) ──
  sendProgress("finalizing", 96, "Uniendo clips...")

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

  if (cancelled) return

  // ── Mix narration audio (if available) ──
  if (audioUrls && audioUrls.length > 0) {
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
