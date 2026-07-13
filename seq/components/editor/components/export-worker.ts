/* ═══════════════════════════════════════════════════════════
   Export Worker v3 — Sincronización con el audio + concat rápido
   - Cada clip se CONFORMA a su ranura de tiempo (start/end del
     análisis): largo → se recorta; corto → se congela el último
     fotograma. Así las escenas caen EXACTAS sobre la narración
     y no se acumula desfase.
   - Clips ya perfectos (24fps h264/aac, duración correcta) se
     copian sin re-codificar (rápido). Solo se re-codifica el
     clip que lo necesita.
   - El volumen de los videos IA se aplica UNA vez en la mezcla
     final con la narración (bajito, debajo de la voz).
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
  duration: number   // ranura de tiempo (end_time - start_time del análisis)
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

// IMPORTANTE: 24, igual que el pre-render del servidor (ensure_export_ready).
// Antes estaba en 30 → NINGÚN clip pre-normalizado pasaba el chequeo y todo
// se re-codificaba en el navegador (lento sin necesidad).
const TARGET_FPS = 24
// Tolerancia de duración: diferencias menores a esto no ameritan re-codificar.
const SLOT_TOLERANCE = 0.25 // segundos

let ffmpeg: FFmpeg | null = null
let cancelled = false
let lastError = ""
let logLines: string[] = []

/* ── Send progress to main thread ── */
function sendProgress(phase: string, progress: number, status: string) {
  self.postMessage({ type: "progress", phase, progress, status })
}

/* ── Load FFmpeg.wasm ── */
async function loadFFmpegWorker(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg
  const ff = new FFmpeg()
  ff.on("log", ({ message }) => {
    logLines.push(message)
    if (logLines.length > 400) logLines.shift()
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

/* ── ¿El clip ya viene en el formato de destino? ── */
function isExportReady(meta: VideoMeta | null | undefined, tw: number, th: number): boolean {
  if (!meta) return false
  const fpsOk = Math.abs(meta.fps - TARGET_FPS) < 1.0
  const resOk = meta.width === tw && meta.height === th
  const codecOk = meta.codec_v === "h264"
  const audioOk = meta.has_audio && meta.codec_a === "aac"
  return fpsOk && resOk && codecOk && audioOk
}

/* ── Duración REAL del clip, leída de los logs de ffmpeg ──
   El meta del servidor no trae duración, así que se sondea aquí:
   `-i archivo` imprime "Duration: 00:00:08.04" en el log. */
async function probeDuration(ff: FFmpeg, file: string): Promise<number | null> {
  logLines = []
  try {
    // Sale con error (no hay salida), pero ya imprimió Duration en el log.
    await ff.exec(["-i", file])
  } catch { /* esperado */ }
  for (const line of logLines) {
    const m = line.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
    if (m) {
      const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
      if (isFinite(sec) && sec > 0) return sec
    }
  }
  return null
}

/* ═══════════════════════════════════════════════════════════
   RUTA ÚNICA: descargar → conformar cada clip a su RANURA →
   concatenar con copia (rápido).
   Por clip se decide:
   - formato perfecto Y duración ≈ ranura → copiar tal cual
   - cualquier otra cosa → una sola pasada de ffmpeg que
     normaliza (fps/res/códec) Y conforma la duración
     (recorta con -t, o congela el último fotograma con tpad).
   ═══════════════════════════════════════════════════════════ */
async function processClips(ff: FFmpeg, clips: SceneClip[], resolution: "720p" | "1080p") {
  const tw = resolution === "1080p" ? 1920 : 1280
  const th = resolution === "1080p" ? 1080 : 720
  let copied = 0
  let conformed = 0

  for (let i = 0; i < clips.length; i++) {
    if (cancelled) return
    const pct = Math.round((i / clips.length) * 88)
    sendProgress("processing", pct, `Clip ${i + 1} de ${clips.length} — descargando...`)

    const response = await fetch(clips[i].videoUrl)
    if (!response.ok) throw new Error(`Error descargando clip ${i + 1}: HTTP ${response.status}`)
    const data = new Uint8Array(await response.arrayBuffer())
    await ff.writeFile(`input_${i}.mp4`, data)

    const slot = clips[i].duration > 0 ? clips[i].duration : 0
    const actual = await probeDuration(ff, `input_${i}.mp4`)
    const durOk = !slot || (actual !== null && Math.abs(actual - slot) <= SLOT_TOLERANCE)
    const ready = isExportReady(clips[i].meta, tw, th)

    if (ready && durOk) {
      // Perfecto: copiar sin re-codificar
      const bytes = await ff.readFile(`input_${i}.mp4`)
      await ff.writeFile(`clip_${i}.mp4`, bytes)
      try { await ff.deleteFile(`input_${i}.mp4`) } catch {}
      copied++
      sendProgress("processing", pct, `Clip ${i + 1} de ${clips.length} — listo ✓`)
      continue
    }

    // Conformar: normalizar formato Y ajustar a la ranura en UNA pasada
    const label = !durOk && actual !== null && slot
      ? (actual > slot
          ? `recortando ${actual.toFixed(1)}s → ${slot.toFixed(1)}s`
          : `extendiendo ${actual.toFixed(1)}s → ${slot.toFixed(1)}s`)
      : "normalizando"
    sendProgress("processing", pct, `Clip ${i + 1} de ${clips.length} — ${label}...`)
    conformed++

    let vf = `fps=${TARGET_FPS},scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2,setsar=1`
    // Clip más corto que su ranura → congelar el último fotograma hasta llenarla
    if (slot && actual !== null && actual < slot - SLOT_TOLERANCE) {
      const padSec = (slot - actual + 1).toFixed(2) // margen; -t corta exacto
      vf += `,tpad=stop_mode=clone:stop_duration=${padSec}`
    }

    const trimArgs = slot ? ["-t", slot.toFixed(2)] : []

    // Intento 1: con su audio (apad rellena silencio si el audio es más corto)
    let ok = false
    try {
      await ff.exec([
        "-i", `input_${i}.mp4`,
        "-vf", vf,
        "-af", "apad",
        ...trimArgs,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-r", String(TARGET_FPS),
        "-y", `clip_${i}.mp4`,
      ])
      const check = await ff.readFile(`clip_${i}.mp4`)
      if (check.length > 500) ok = true
    } catch { ok = false }

    if (!ok) {
      // Intento 2: el clip no tiene audio → pista de silencio
      try {
        await ff.exec([
          "-i", `input_${i}.mp4`,
          "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
          "-vf", vf,
          "-map", "0:v", "-map", "1:a",
          ...trimArgs,
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
          "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
          "-r", String(TARGET_FPS),
          ...(slot ? [] : ["-shortest"]),
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

  // ── Concatenar con copia de streams (rápido, sin re-codificar) ──
  sendProgress("finalizing", 90, `Uniendo ${clips.length} clips (${copied} directos, ${conformed} ajustados)...`)

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

/* ── Mezclar la narración ──
   videoVolume: atenuación del audio ambiental de los videos IA (ej. 0.10 = 10%,
   bien bajito debajo de la voz). duration=longest: si la narración dura más que
   el video, NO se corta. */
async function mixNarration(ff: FFmpeg, audioUrls: string[], videoVolume: number = 1.0) {
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
    const ambFilter = `[0:a]volume=${videoVolume.toFixed(2)}[amb]`
    await ff.exec([
      "-i", "video_only.mp4",
      "-i", `narration.${ext}`,
      "-filter_complex", `${ambFilter};[amb][1:a]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[aout]`,
      "-map", "0:v", "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      "-y", "output.mp4",
    ])
  } catch {
    // Respaldo: narración como único audio
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

  // Volumen del audio ambiental de los videos IA (slider por clip, 0-200 → 0.0-2.0).
  // Se aplica UNA sola vez, en la mezcla con la narración (los clips conservan su
  // audio original al conformarse, así nunca se atenúa dos veces).
  const avgClipVolume = clips.length
    ? clips.reduce((sum, c) => sum + (c.volume ?? 10), 0) / clips.length / 100
    : 0.10

  await processClips(ff, clips, resolution)
  if (cancelled) return

  await mixNarration(ff, audioUrls, avgClipVolume)
  if (cancelled) return

  // ── Verificar y enviar ──
  sendProgress("finalizing", 98, "Verificando...")

  const outputData = await ff.readFile("output.mp4")
  if (outputData.length < 10000) {
    throw new Error(`Archivo muy pequeño (${(outputData.length / 1024).toFixed(0)} KB). FFmpeg: ${lastError}`)
  }
  try { await ff.deleteFile("output.mp4") } catch {}

  const totalMB = (outputData.length / 1024 / 1024).toFixed(1)

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
