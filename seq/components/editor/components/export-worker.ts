/* ═══════════════════════════════════════════════════════════
   Export Worker v4 — Memoria reciclada para capítulos LARGOS
   (fix de "RuntimeError: memory access out of bounds")

   El problema: FFmpeg.wasm vive en un heap de WebAssembly que
   SOLO puede crecer, nunca devolver memoria. Cada clip que se
   re-codifica deja el heap más grande; con 50-70 clips (videos
   de 10-12 minutos) el heap revienta el límite del navegador.

   La solución v4:
   - Cada clip procesado se saca INMEDIATAMENTE del sistema de
     archivos de FFmpeg a un Blob (memoria normal del navegador,
     que el recolector de basura SÍ libera).
   - La instancia de FFmpeg se TERMINA y se recrea cada pocos
     clips (RESET_EVERY): el heap vuelve a empezar de cero una
     y otra vez, y nunca llega al límite.
   - La unión final se hace POR PARTES (CONCAT_CHUNK clips por
     parte, con copia de streams) también con instancias frescas.
   - El núcleo de FFmpeg (js+wasm) se descarga UNA sola vez y se
     cachea como blob URL: los reinicios tardan ~1-2s, no re-descargan.

   Se conserva TODO lo de v3: conformar cada clip a su ranura
   (recortar / congelar último fotograma), copia directa de los
   clips ya perfectos, mezcla de narración con duration=longest
   y volumen bajito para el audio de los videos IA.

   El protocolo de mensajes con export-queue NO cambia
   (progress / done / error / cancel): solo cambia este archivo.
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
const TARGET_FPS = 24
// Tolerancia de duración: diferencias menores a esto no ameritan re-codificar.
const SLOT_TOLERANCE = 0.25 // segundos
// Reciclaje de memoria: reiniciar la instancia de FFmpeg cada N clips procesados.
const RESET_EVERY = 10
// Unión por partes: máximo de clips por parte al concatenar (limita el tamaño
// del sistema de archivos de FFmpeg en cada instancia).
const CONCAT_CHUNK = 20

let ffmpeg: FFmpeg | null = null
let cancelled = false
let lastError = ""
let logLines: string[] = []

// Núcleo de FFmpeg cacheado como blob URLs (se descarga UNA vez por sesión).
let coreBlobURL: string | null = null
let wasmBlobURL: string | null = null

/* ── Send progress to main thread ── */
function sendProgress(phase: string, progress: number, status: string) {
  self.postMessage({ type: "progress", phase, progress, status })
}

/* ── Load FFmpeg.wasm (núcleo cacheado; los reinicios no re-descargan) ── */
async function loadFFmpegWorker(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg
  if (!coreBlobURL || !wasmBlobURL) {
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd"
    coreBlobURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript")
    wasmBlobURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm")
  }
  const ff = new FFmpeg()
  ff.on("log", ({ message }) => {
    logLines.push(message)
    if (logLines.length > 400) logLines.shift()
    if (message.toLowerCase().includes("error") || message.toLowerCase().includes("invalid")) {
      lastError = message
    }
  })
  await ff.load({ coreURL: coreBlobURL, wasmURL: wasmBlobURL })
  ffmpeg = ff
  return ff
}

/* ── Reciclar la instancia: termina el heap viejo y arranca uno fresco ── */
async function resetFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) {
    try { ffmpeg.terminate() } catch {}
    ffmpeg = null
  }
  return loadFFmpegWorker()
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

/* ── Duración REAL del clip, leída de los logs de ffmpeg ── */
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

/* ── Leer un archivo del FS de FFmpeg y sacarlo a un Blob del navegador ── */
async function takeFileAsBlob(ff: FFmpeg, name: string): Promise<Blob> {
  const data = await ff.readFile(name)
  try { await ff.deleteFile(name) } catch {}
  // Copia defensiva: el buffer de readFile pertenece al heap de wasm; al
  // terminar la instancia podría invalidarse. slice() lo trae a memoria JS.
  const bytes = (data as Uint8Array).slice()
  return new Blob([bytes], { type: "video/mp4" })
}

/* ═══════════════════════════════════════════════════════════
   FASE 1: procesar cada clip a su RANURA y sacarlo a un Blob.
   La instancia de FFmpeg se recicla cada RESET_EVERY clips.
   Devuelve la lista de Blobs (uno por clip, en orden).
   ═══════════════════════════════════════════════════════════ */
async function processClips(
  clips: SceneClip[],
  resolution: "720p" | "1080p",
): Promise<(Blob | null)[]> {
  const tw = resolution === "1080p" ? 1920 : 1280
  const th = resolution === "1080p" ? 1080 : 720
  let copied = 0
  let conformed = 0
  const out: (Blob | null)[] = new Array(clips.length).fill(null)

  let ff = await loadFFmpegWorker()

  for (let i = 0; i < clips.length; i++) {
    if (cancelled) return out
    const pct = Math.round((i / clips.length) * 80)
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
      // Perfecto: copiar sin re-codificar (solo se saca al Blob)
      out[i] = await takeFileAsBlob(ff, `input_${i}.mp4`)
      copied++
      sendProgress("processing", pct, `Clip ${i + 1} de ${clips.length} — listo ✓`)
    } else {
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
      out[i] = await takeFileAsBlob(ff, `clip_${i}.mp4`)
    }

    // ── RECICLAJE DE MEMORIA: instancia fresca cada RESET_EVERY clips ──
    // El heap de wasm solo crece; reiniciarlo aquí evita el
    // "memory access out of bounds" en capítulos largos (50+ clips).
    if ((i + 1) % RESET_EVERY === 0 && i + 1 < clips.length) {
      sendProgress("processing", pct, `Liberando memoria (${i + 1}/${clips.length})...`)
      ff = await resetFFmpeg()
    }
  }

  sendProgress("processing", 82, `${clips.length} clips listos (${copied} directos, ${conformed} ajustados)`)
  return out
}

/* ═══════════════════════════════════════════════════════════
   FASE 2: unir por PARTES con copia de streams.
   Cada parte une hasta CONCAT_CHUNK clips en una instancia
   fresca; luego las partes se unen entre sí (también con copia).
   ═══════════════════════════════════════════════════════════ */
async function concatBlobs(
  pieces: (Blob | null)[],
  label: string,
  progressBase: number,
): Promise<Blob> {
  const valid = pieces.filter((b): b is Blob => b !== null)
  if (!valid.length) throw new Error("No hay clips para unir")
  if (valid.length === 1) return valid[0]

  // Dividir en grupos de CONCAT_CHUNK
  const groups: Blob[][] = []
  for (let i = 0; i < valid.length; i += CONCAT_CHUNK) {
    groups.push(valid.slice(i, i + CONCAT_CHUNK))
  }

  const partBlobs: Blob[] = []
  for (let g = 0; g < groups.length; g++) {
    if (cancelled) throw new Error("Cancelado")
    sendProgress(
      "finalizing",
      progressBase + Math.round((g / groups.length) * 6),
      `${label} — parte ${g + 1} de ${groups.length}...`,
    )
    const ff = await resetFFmpeg() // instancia fresca por parte
    let list = ""
    for (let i = 0; i < groups[g].length; i++) {
      const bytes = new Uint8Array(await groups[g][i].arrayBuffer())
      await ff.writeFile(`part_in_${i}.mp4`, bytes)
      list += `file 'part_in_${i}.mp4'\n`
    }
    await ff.writeFile("concat.txt", new TextEncoder().encode(list))
    await ff.exec([
      "-f", "concat", "-safe", "0", "-i", "concat.txt",
      "-c", "copy",
      "-movflags", "+faststart",
      "-y", "part_out.mp4",
    ])
    partBlobs.push(await takeFileAsBlob(ff, "part_out.mp4"))
    // Liberar los blobs de este grupo (ya viven dentro de la parte)
    groups[g].length = 0
  }

  if (partBlobs.length === 1) return partBlobs[0]
  // Unir las partes entre sí (recursivo; con CONCAT_CHUNK=20 casi siempre 1 nivel)
  return concatBlobs(partBlobs, `${label} (final)`, progressBase + 6)
}

/* ── FASE 3: mezclar la narración (instancia fresca) ── */
async function mixNarration(videoBlob: Blob, audioUrls: string[], videoVolume: number): Promise<Blob> {
  if (!audioUrls || audioUrls.length === 0) return videoBlob

  sendProgress("finalizing", 93, "Descargando narración...")

  const narrationUrl = audioUrls[0]
  const narResponse = await fetch(narrationUrl)
  if (!narResponse.ok) throw new Error(`Error descargando narración: HTTP ${narResponse.status}`)
  const narData = new Uint8Array(await narResponse.arrayBuffer())

  // Extensión segura: con URLs del proxy la URL termina en el token (tiene puntos),
  // así que solo se acepta una extensión corta conocida; si no, mp3.
  const rawExt = narrationUrl.split(".").pop()?.split("?")[0]?.split("&")[0] || "mp3"
  const ext = /^[a-z0-9]{2,4}$/i.test(rawExt) ? rawExt.toLowerCase() : "mp3"

  const ff = await resetFFmpeg() // instancia fresca para la mezcla
  await ff.writeFile(`narration.${ext}`, narData)
  await ff.writeFile("video_only.mp4", new Uint8Array(await videoBlob.arrayBuffer()))

  if (cancelled) throw new Error("Cancelado")
  sendProgress("finalizing", 95, "Mezclando narración...")

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
  return takeFileAsBlob(ff, "output.mp4")
}

/* ── Main export function ── */
async function runExport(clips: SceneClip[], resolution: "720p" | "1080p", audioUrls: string[]) {
  cancelled = false
  lastError = ""

  sendProgress("loading", 0, "Preparando...")
  await loadFFmpegWorker()
  if (cancelled) return

  // Volumen del audio ambiental de los videos IA (slider por clip, 0-200 → 0.0-2.0).
  const avgClipVolume = clips.length
    ? clips.reduce((sum, c) => sum + (c.volume ?? 10), 0) / clips.length / 100
    : 0.10

  // FASE 1: cada clip a su ranura, resultado en Blobs, memoria reciclada
  const clipBlobs = await processClips(clips, resolution)
  if (cancelled) return

  // FASE 2: unión por partes
  sendProgress("finalizing", 84, `Uniendo ${clips.length} clips...`)
  const joined = await concatBlobs(clipBlobs, "Uniendo", 84)
  // Liberar los blobs individuales (ya viven dentro de joined)
  clipBlobs.fill(null)
  if (cancelled) return

  // FASE 3: narración
  const finalBlob = await mixNarration(joined, audioUrls, avgClipVolume)
  if (cancelled) return

  // ── Verificar y enviar ──
  sendProgress("finalizing", 98, "Verificando...")

  if (finalBlob.size < 10000) {
    throw new Error(`Archivo muy pequeño (${(finalBlob.size / 1024).toFixed(0)} KB). FFmpeg: ${lastError}`)
  }

  // Cerrar la instancia: el trabajo terminó, que no quede heap vivo
  if (ffmpeg) {
    try { ffmpeg.terminate() } catch {}
    ffmpeg = null
  }

  const totalMB = (finalBlob.size / 1024 / 1024).toFixed(1)
  const buffer = await finalBlob.arrayBuffer()
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
      if (cancelled) return // cancelado por el usuario: la cola ya marcó el job
      const errMsg = err instanceof Error ? err.message : `Error desconocido. FFmpeg: ${lastError}`
      self.postMessage({ type: "error", error: errMsg })
    }
  } else if (msg.type === "cancel") {
    cancelled = true
    // Terminar la instancia activa aborta el exec en curso de inmediato
    if (ffmpeg) {
      try { ffmpeg.terminate() } catch {}
      ffmpeg = null
    }
  }
}
