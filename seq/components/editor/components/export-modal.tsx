"use client"

import { memo, useState, useEffect, useCallback, useRef } from "react"
import { DownloadIcon, CheckCircleIcon } from "./icons"
import { FFmpeg } from "@ffmpeg/ffmpeg"
import { toBlobURL } from "@ffmpeg/util"

/* ── Backend URL ── */
const BACKEND_URL =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:8000"
    : "https://zentrix-backend-mcvk.onrender.com"

const TOKEN_KEY = "zentrix_token"

/* ── Types ── */
interface ExportModalProps {
  isOpen: boolean
  onClose: () => void
  onStartExport: (resolution: "720p" | "1080p") => void
  isExporting: boolean
  exportProgress: number
  exportPhase: "idle" | "init" | "audio" | "video" | "encoding" | "complete"
  downloadUrl: string | null
  onCancel: () => void
  hasRenderedPreview?: boolean
  ffmpegError?: string | null
  chapterId?: string | null
  chapterProjectName?: string
  chapterNumber?: number
  chapterTitle?: string
}

type ExportPhase = "idle" | "loading" | "downloading" | "normalizing" | "merging" | "done" | "error"

interface SceneClip {
  index: number
  videoUrl: string
  duration: number
  volume: number
  actualDuration?: number // measured after normalization
}

const XFADE_DURATION = 1
const TARGET_FPS = 30
const BATCH_SIZE = 10 // xfade in groups of 10 for reliability

/* ── Helpers ── */
const formatTime = (sec: number) => {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

async function apiFetch(path: string) {
  const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : ""
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(BACKEND_URL + path, { headers })
  if (!res.ok) throw new Error(`API error ${res.status}`)
  return res.json()
}

/* ── Resolution Selector ── */
const ResolutionSelector = memo(function ResolutionSelector({
  resolution,
  onSelect,
}: {
  resolution: "720p" | "1080p"
  onSelect: (res: "720p" | "1080p") => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        onClick={() => onSelect("1080p")}
        className={`p-3 rounded-lg border text-left transition-all ${resolution === "1080p" ? "bg-[var(--tertiary-muted)] border-[var(--tertiary)]" : "bg-[var(--surface-1)] border-[var(--border-default)] hover:border-[var(--border-emphasis)]"}`}
      >
        <div className={`text-sm font-medium ${resolution === "1080p" ? "text-[var(--tertiary)]" : "text-[var(--text-primary)]"}`}>
          1080p
        </div>
        <div className="text-[10px] text-[var(--text-secondary)] mt-1">1920×1080 · Mejor calidad</div>
      </button>
      <button
        onClick={() => onSelect("720p")}
        className={`p-3 rounded-lg border text-left transition-all ${resolution === "720p" ? "bg-[var(--tertiary-muted)] border-[var(--tertiary)]" : "bg-[var(--surface-1)] border-[var(--border-default)] hover:border-[var(--border-emphasis)]"}`}
      >
        <div className={`text-sm font-medium ${resolution === "720p" ? "text-[var(--tertiary)]" : "text-[var(--text-primary)]"}`}>
          720p
        </div>
        <div className="text-[10px] text-[var(--text-secondary)] mt-1">1280×720 · Más rápido</div>
      </button>
    </div>
  )
})

/* ═══════════════════════════════════════════════════════════════
   EXPORT MODAL
   ═══════════════════════════════════════════════════════════════ */
export const ExportModal = memo(function ExportModal({
  isOpen,
  onClose,
  onStartExport,
  isExporting,
  exportProgress,
  exportPhase,
  downloadUrl,
  onCancel,
  hasRenderedPreview = false,
  ffmpegError,
  chapterId,
  chapterProjectName,
  chapterNumber,
  chapterTitle,
}: ExportModalProps) {
  const [resolution, setResolution] = useState<"720p" | "1080p">("1080p")

  /* ── Export State ── */
  const [phase, setPhase] = useState<ExportPhase>("idle")
  const [progress, setProgress] = useState(0)
  const [statusMsg, setStatusMsg] = useState("")
  const [detailMsg, setDetailMsg] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const [localDownloadUrl, setLocalDownloadUrl] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [clipCount, setClipCount] = useState(0)
  const ffmpegRef = useRef<FFmpeg | null>(null)
  const cancelledRef = useRef(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const startTimeRef = useRef(0)
  const detectedDurationRef = useRef<number>(0)

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  useEffect(() => {
    if (isOpen && phase !== "downloading" && phase !== "normalizing" && phase !== "merging" && phase !== "loading") {
      setPhase("idle")
      setProgress(0)
      setStatusMsg("")
      setDetailMsg("")
      setErrorMsg("")
    }
  }, [isOpen])

  /* ── Timer ── */
  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now()
    setElapsed(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
  }, [])

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  /* ── Load FFmpeg.wasm ── */
  const loadFFmpeg = async (): Promise<FFmpeg> => {
    if (ffmpegRef.current) return ffmpegRef.current
    const ffmpeg = new FFmpeg()
    // Capture duration from FFmpeg logs
    ffmpeg.on("log", ({ message }) => {
      const durMatch = message.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
      if (durMatch) {
        const h = parseInt(durMatch[1])
        const m = parseInt(durMatch[2])
        const s = parseInt(durMatch[3])
        const cs = parseInt(durMatch[4])
        detectedDurationRef.current = h * 3600 + m * 60 + s + cs / 100
      }
    })
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd"
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    })
    ffmpegRef.current = ffmpeg
    return ffmpeg
  }

  /* ── Fetch scene clips from backend ── */
  const fetchSceneClips = async (): Promise<SceneClip[]> => {
    if (!chapterId) throw new Error("No chapter loaded")
    const data = await apiFetch(`/api/image-studio/chapters/${chapterId}/video-progress`)
    if (!data.videos || !Array.isArray(data.videos)) throw new Error("No videos found")
    const clips: SceneClip[] = []
    for (const vid of data.videos) {
      const url = vid.veo_url || vid.kb_url
      const status = vid.veo_url ? vid.veo_status : vid.kb_status
      if (status === "done" && url) {
        clips.push({
          index: vid.segment_index,
          videoUrl: url,
          duration: vid.duration || 8,
          volume: vid.volume ?? 30,
        })
      }
    }
    clips.sort((a, b) => a.index - b.index)
    if (clips.length === 0) throw new Error("No hay clips con video generado")
    return clips
  }

  /* ── Probe actual duration of a file ── */
  const probeFileDuration = async (ffmpeg: FFmpeg, filename: string): Promise<number> => {
    detectedDurationRef.current = 0
    try {
      await ffmpeg.exec(["-i", filename, "-f", "null", "-"])
    } catch {
      // ffmpeg returns non-zero when writing to null, but we got the duration from logs
    }
    return detectedDurationRef.current
  }

  /* ── xfade a list of files, return output filename ── */
  const xfadeFiles = async (
    ffmpeg: FFmpeg,
    inputFiles: string[],
    durations: number[],
    outputFile: string,
  ): Promise<boolean> => {
    if (inputFiles.length === 0) return false

    if (inputFiles.length === 1) {
      // Single file — just copy
      const data = await ffmpeg.readFile(inputFiles[0])
      await ffmpeg.writeFile(outputFile, data)
      return true
    }

    // Build input args
    const inputArgs: string[] = []
    for (const f of inputFiles) {
      inputArgs.push("-i", f)
    }

    // Build xfade filter chain
    let videoFilter = ""
    let audioFilter = ""
    let cumulativeOffset = 0
    const n = inputFiles.length

    for (let i = 0; i < n - 1; i++) {
      const clipDur = durations[i]
      // Ensure offset is positive and valid
      const offset = Math.max(0, cumulativeOffset + clipDur - XFADE_DURATION)
      const inLabel = i === 0 ? `[${i}:v]` : `[v${i}]`
      const nextLabel = `[${i + 1}:v]`
      const outLabel = i === n - 2 ? "[vout]" : `[v${i + 1}]`

      videoFilter += `${inLabel}${nextLabel}xfade=transition=fade:duration=${XFADE_DURATION}:offset=${offset.toFixed(3)}${outLabel}`
      if (i < n - 2) videoFilter += ";"

      const aIn = i === 0 ? `[${i}:a]` : `[a${i}]`
      const aNext = `[${i + 1}:a]`
      const aOut = i === n - 2 ? "[aout]" : `[a${i + 1}]`

      audioFilter += `${aIn}${aNext}acrossfade=d=${XFADE_DURATION}:c1=tri:c2=tri${aOut}`
      if (i < n - 2) audioFilter += ";"

      cumulativeOffset = offset
    }

    const filterComplex = videoFilter + ";" + audioFilter

    try {
      await ffmpeg.exec([
        ...inputArgs,
        "-filter_complex", filterComplex,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", outputFile,
      ])

      // Verify output exists and has content
      const result = await ffmpeg.readFile(outputFile)
      if (result.length < 1000) {
        console.warn(`xfade output ${outputFile} too small (${result.length} bytes), likely corrupted`)
        return false
      }
      return true
    } catch (err) {
      console.warn(`xfade failed for ${outputFile}:`, err)
      return false
    }
  }

  /* ── Concat fallback (no transitions, just join) ── */
  const concatFiles = async (
    ffmpeg: FFmpeg,
    inputFiles: string[],
    outputFile: string,
  ): Promise<void> => {
    let concatList = ""
    for (const f of inputFiles) {
      concatList += `file '${f}'\n`
    }
    const encoder = new TextEncoder()
    await ffmpeg.writeFile("concat_list.txt", encoder.encode(concatList))

    await ffmpeg.exec([
      "-f", "concat", "-safe", "0", "-i", "concat_list.txt",
      "-c", "copy",
      "-movflags", "+faststart",
      "-y", outputFile,
    ])
  }

  /* ══════════════════════════════════════
     EXPORT FLOW
     ══════════════════════════════════════ */
  const handleExport = useCallback(async () => {
    cancelledRef.current = false
    setPhase("loading")
    setProgress(0)
    setStatusMsg("Preparando...")
    setDetailMsg("")
    setErrorMsg("")
    setLocalDownloadUrl(null)
    startTimer()

    try {
      const ffmpeg = await loadFFmpeg()
      if (cancelledRef.current) { stopTimer(); return }

      // Fetch scenes
      setStatusMsg("Obteniendo escenas...")
      const clips = await fetchSceneClips()
      setClipCount(clips.length)
      if (cancelledRef.current) { stopTimer(); return }

      const tw = resolution === "1080p" ? 1920 : 1280
      const th = resolution === "1080p" ? 1080 : 720

      // ════════════════════════════════════════
      // PHASE 1: Download all clips
      // ════════════════════════════════════════
      setPhase("downloading")
      for (let i = 0; i < clips.length; i++) {
        if (cancelledRef.current) { stopTimer(); return }
        setStatusMsg(`Descargando clip ${i + 1} de ${clips.length}`)
        setProgress(Math.round((i / clips.length) * 100))

        const response = await fetch(clips[i].videoUrl)
        if (!response.ok) throw new Error(`Error descargando clip ${i + 1}: HTTP ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        await ffmpeg.writeFile(`input_${i}.mp4`, data)
      }

      if (cancelledRef.current) { stopTimer(); return }

      // ════════════════════════════════════════
      // PHASE 2: Normalize + measure actual durations
      // ════════════════════════════════════════
      setPhase("normalizing")
      setProgress(0)

      const actualDurations: number[] = []

      for (let i = 0; i < clips.length; i++) {
        if (cancelledRef.current) { stopTimer(); return }
        setStatusMsg(`Procesando clip ${i + 1} de ${clips.length}`)
        setProgress(Math.round((i / clips.length) * 100))

        const vol = clips[i].volume / 100
        const vf = `fps=${TARGET_FPS},scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2,setsar=1`

        // Try with audio
        let normOk = false
        try {
          await ffmpeg.exec([
            "-i", `input_${i}.mp4`,
            "-vf", vf,
            "-af", `volume=${vol.toFixed(2)}`,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
            "-r", String(TARGET_FPS),
            "-y", `norm_${i}.mp4`,
          ])
          try { await ffmpeg.readFile(`norm_${i}.mp4`); normOk = true } catch { normOk = false }
        } catch { normOk = false }

        if (!normOk) {
          // No audio — add silent audio
          await ffmpeg.exec([
            "-i", `input_${i}.mp4`,
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-vf", vf,
            "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
            "-r", String(TARGET_FPS),
            "-shortest",
            "-y", `norm_${i}.mp4`,
          ])
        }

        // Free input
        try { await ffmpeg.deleteFile(`input_${i}.mp4`) } catch {}

        // Measure actual duration
        const dur = await probeFileDuration(ffmpeg, `norm_${i}.mp4`)
        actualDurations.push(dur > 0 ? dur : clips[i].duration)
        setDetailMsg(`Clip ${i + 1}: ${dur.toFixed(1)}s real`)
      }

      if (cancelledRef.current) { stopTimer(); return }

      // ════════════════════════════════════════
      // PHASE 3: Merge with BATCHED xfade
      // ════════════════════════════════════════
      setPhase("merging")
      setProgress(0)

      // Split into batches
      const numBatches = Math.ceil(clips.length / BATCH_SIZE)
      const batchFiles: string[] = []
      const batchDurations: number[] = []

      for (let b = 0; b < numBatches; b++) {
        if (cancelledRef.current) { stopTimer(); return }
        const startIdx = b * BATCH_SIZE
        const endIdx = Math.min(startIdx + BATCH_SIZE, clips.length)
        const batchClipFiles = []
        const batchClipDurations = []

        for (let i = startIdx; i < endIdx; i++) {
          batchClipFiles.push(`norm_${i}.mp4`)
          batchClipDurations.push(actualDurations[i])
        }

        const batchFile = `batch_${b}.mp4`
        setStatusMsg(`Uniendo lote ${b + 1} de ${numBatches} (clips ${startIdx + 1}-${endIdx})`)
        setProgress(Math.round((b / numBatches) * 80))

        if (batchClipFiles.length === 1) {
          // Single clip batch — just rename
          const d = await ffmpeg.readFile(batchClipFiles[0])
          await ffmpeg.writeFile(batchFile, d)
        } else {
          const xfadeOk = await xfadeFiles(ffmpeg, batchClipFiles, batchClipDurations, batchFile)
          if (!xfadeOk) {
            // Fallback: concat without transitions
            setDetailMsg(`Lote ${b + 1}: usando concat simple`)
            await concatFiles(ffmpeg, batchClipFiles, batchFile)
          }
        }

        // Clean up normalized clips in this batch
        for (const f of batchClipFiles) {
          try { await ffmpeg.deleteFile(f) } catch {}
        }

        // Measure batch duration for next stage
        const batchDur = await probeFileDuration(ffmpeg, batchFile)
        batchFiles.push(batchFile)
        batchDurations.push(batchDur > 0 ? batchDur : batchClipDurations.reduce((a, b) => a + b, 0) - (batchClipDurations.length - 1) * XFADE_DURATION)
      }

      if (cancelledRef.current) { stopTimer(); return }

      // Final merge: xfade the batches together
      if (batchFiles.length === 1) {
        setStatusMsg("Finalizando video...")
        const d = await ffmpeg.readFile(batchFiles[0])
        await ffmpeg.writeFile("output.mp4", d)
        try { await ffmpeg.deleteFile(batchFiles[0]) } catch {}
      } else {
        setStatusMsg(`Uniendo ${batchFiles.length} lotes finales...`)
        setProgress(85)

        const finalXfadeOk = await xfadeFiles(ffmpeg, batchFiles, batchDurations, "output.mp4")
        if (!finalXfadeOk) {
          setDetailMsg("Usando concat simple para unión final")
          await concatFiles(ffmpeg, batchFiles, "output.mp4")
        }

        // Clean up batch files
        for (const f of batchFiles) {
          try { await ffmpeg.deleteFile(f) } catch {}
        }
      }

      if (cancelledRef.current) { stopTimer(); return }

      // ════════════════════════════════════════
      // PHASE 4: Verify + download
      // ════════════════════════════════════════
      setStatusMsg("Verificando video...")
      setProgress(95)

      const outputData = await ffmpeg.readFile("output.mp4")
      if (outputData.length < 10000) {
        throw new Error(`Archivo de salida demasiado pequeño (${outputData.length} bytes). El video no se generó correctamente.`)
      }

      // Check duration of final output
      const finalDuration = await probeFileDuration(ffmpeg, "output.mp4")
      if (finalDuration < 1) {
        throw new Error("El video final tiene duración 0. Posible error de codificación.")
      }

      const blob = new Blob([outputData], { type: "video/mp4" })
      const url = URL.createObjectURL(blob)
      try { await ffmpeg.deleteFile("output.mp4") } catch {}

      setLocalDownloadUrl(url)
      setPhase("done")
      setProgress(100)
      setStatusMsg("¡Exportación completa!")
      setDetailMsg(`${clips.length} clips · ${Math.round(finalDuration)}s · ${resolution}`)
      stopTimer()
    } catch (err: unknown) {
      if (cancelledRef.current) { stopTimer(); return }
      const msg = err instanceof Error ? err.message : "Error desconocido"
      console.error("Export error:", err)
      setPhase("error")
      setErrorMsg(msg)
      stopTimer()
    }
  }, [chapterId, resolution, startTimer, stopTimer])

  const handleCancel = useCallback(() => {
    cancelledRef.current = true
    setPhase("idle")
    setProgress(0)
    setStatusMsg("")
    setDetailMsg("")
    stopTimer()
  }, [stopTimer])

  const handleDownload = useCallback(() => {
    if (!localDownloadUrl) return
    const a = document.createElement("a")
    a.href = localDownloadUrl
    const safeName = `${chapterProjectName || "zentrix"}_cap${chapterNumber || 1}`.replace(/[^a-zA-Z0-9_-]/g, "_")
    a.download = `${safeName}.mp4`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [localDownloadUrl, chapterProjectName, chapterNumber])

  const handleClose = useCallback(() => {
    if (phase === "downloading" || phase === "normalizing" || phase === "merging" || phase === "loading") {
      if (!confirm("¿Cancelar la exportación en progreso?")) return
      cancelledRef.current = true
      stopTimer()
    }
    setPhase("idle")
    onClose()
  }, [phase, onClose, stopTimer])

  const handleStartClick = useCallback(() => {
    if (chapterId) {
      handleExport()
    } else {
      onStartExport(resolution)
    }
  }, [chapterId, handleExport, onStartExport, resolution])

  if (!isOpen) return null

  const isWorking = phase === "loading" || phase === "downloading" || phase === "normalizing" || phase === "merging"

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--surface-0)] border border-[var(--border-default)] rounded-xl shadow-2xl w-[500px] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="h-14 px-6 flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--surface-0)]">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider">Exportar Video</h3>
          <button onClick={handleClose} className="text-[var(--text-secondary)] hover:text-white transition-colors" disabled={isExporting}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* ── Working ── */}
          {isWorking ? (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">
                    {phase === "loading" && "Preparando..."}
                    {phase === "downloading" && "Descargando clips..."}
                    {phase === "normalizing" && "Procesando clips..."}
                    {phase === "merging" && "Uniendo con transiciones..."}
                  </p>
                  <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">{statusMsg}</p>
                  {detailMsg && <p className="text-[9px] text-[var(--text-muted)] mt-0.5">{detailMsg}</p>}
                </div>
                <span className="text-xs text-[var(--text-secondary)] font-mono">{formatTime(elapsed)}</span>
              </div>

              <div className="space-y-1.5">
                <div className="h-2 w-full bg-[var(--surface-2)] rounded-full overflow-hidden">
                  {phase === "loading" ? (
                    <div className="h-full bg-[var(--tertiary-muted)] w-full animate-pulse" />
                  ) : (
                    <div className="h-full bg-[var(--tertiary)] transition-all duration-300 rounded-full" style={{ width: `${progress}%` }} />
                  )}
                </div>
                {phase !== "loading" && (
                  <div className="flex justify-between">
                    <span className="text-[10px] text-[var(--text-secondary)]">{clipCount} clips · {resolution}</span>
                    <span className="text-xs text-[var(--tertiary)] font-medium">{progress}%</span>
                  </div>
                )}
              </div>

              <button onClick={handleCancel} className="mt-1 text-sm text-[var(--error)] hover:text-[var(--error-hover)] transition-colors">
                Cancelar
              </button>
            </div>

          ) : phase === "done" && localDownloadUrl ? (
            /* ── Done ── */
            <div className="flex flex-col items-center gap-4 py-4 animate-in zoom-in-95">
              <div className="w-16 h-16 rounded-full bg-[var(--success-muted)] text-[var(--success)] flex items-center justify-center mb-2">
                <CheckCircleIcon className="w-8 h-8" />
              </div>
              <h4 className="text-lg font-semibold text-white">¡Exportación completa!</h4>
              <p className="text-xs text-[var(--text-secondary)]">{detailMsg || `${clipCount} clips · ${resolution} · ${formatTime(elapsed)}`}</p>

              <button
                onClick={handleDownload}
                className="mt-2 w-full flex items-center justify-center gap-2 px-6 py-3 bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg font-medium transition-all shadow-lg cursor-pointer"
              >
                <DownloadIcon className="w-4 h-4" />
                Descargar MP4
              </button>

              <video src={localDownloadUrl} controls className="w-full rounded-lg border border-[var(--border-default)] mt-1" style={{ maxHeight: "200px" }} />

              <button onClick={handleClose} className="text-sm text-[var(--text-secondary)] hover:text-white">Cerrar</button>
            </div>

          ) : phase === "error" ? (
            /* ── Error ── */
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="w-16 h-16 rounded-full bg-[var(--error-muted)] text-[var(--error)] flex items-center justify-center mb-2">
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
                </svg>
              </div>
              <h4 className="text-lg font-semibold text-white">Error en la exportación</h4>
              <p className="text-sm text-[var(--text-tertiary)] text-center max-w-sm break-words">{errorMsg}</p>
              <div className="flex gap-3 mt-2">
                <button onClick={() => { setPhase("idle"); setErrorMsg("") }} className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white rounded-lg text-sm transition-colors">
                  Volver
                </button>
                <button onClick={handleExport} className="px-4 py-2 bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg text-sm transition-colors">
                  Reintentar
                </button>
              </div>
            </div>

          /* ── Server export fallback (no chapterId) ── */
          ) : !chapterId && ffmpegError ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <h4 className="text-lg font-semibold text-white">Export no disponible</h4>
              <p className="text-sm text-[var(--text-tertiary)] text-center max-w-sm">{ffmpegError}</p>
              <button onClick={handleClose} className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white rounded-lg text-sm transition-colors">Cerrar</button>
            </div>

          ) : !chapterId && downloadUrl ? (
            <div className="flex flex-col items-center gap-4 py-4 animate-in zoom-in-95">
              <div className="w-16 h-16 rounded-full bg-[var(--success-muted)] text-[var(--success)] flex items-center justify-center mb-2">
                <CheckCircleIcon className="w-8 h-8" />
              </div>
              <h4 className="text-lg font-semibold text-white">¡Exportación completa!</h4>
              <a href={downloadUrl} download="project_export.mp4" className="mt-2 w-full flex items-center justify-center gap-2 px-6 py-3 bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg font-medium transition-all shadow-lg">
                <DownloadIcon className="w-4 h-4" />Descargar MP4
              </a>
              <button onClick={handleClose} className="text-sm text-[var(--text-secondary)] hover:text-white">Cerrar</button>
            </div>

          ) : !chapterId && isExporting ? (
            <div className="flex flex-col gap-5 py-4">
              <div className="text-center">
                <p className="text-sm font-medium text-white">Exportando...</p>
              </div>
              <div className="h-2 w-full bg-[var(--surface-2)] rounded-full overflow-hidden">
                <div className="h-full bg-[var(--tertiary)] transition-all duration-300" style={{ width: `${exportProgress}%` }} />
              </div>
              <button onClick={onCancel} className="mt-1 text-sm text-[var(--error)] hover:text-[var(--error-hover)] transition-colors">Cancelar</button>
            </div>

          ) : (
            /* ── Pre-export ── */
            <div className="flex flex-col gap-5">
              {chapterProjectName && (
                <div className="flex items-center justify-between text-[11px] p-3 rounded-lg bg-[var(--surface-1)] border border-[var(--border-default)]">
                  <div>
                    <div className="text-white font-medium">{chapterProjectName}</div>
                    <div className="text-[var(--text-secondary)]">Cap {chapterNumber}: {chapterTitle}</div>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <label className="text-xs font-bold text-[var(--text-secondary)] uppercase">Calidad</label>
                <ResolutionSelector resolution={resolution} onSelect={setResolution} />
              </div>

              <button
                onClick={handleStartClick}
                className="w-full py-3 bg-white text-black font-bold rounded-lg hover:bg-gray-200 transition-colors shadow-lg mt-2 flex items-center justify-center gap-2"
              >
                Exportar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

ExportModal.displayName = "ExportModal"
