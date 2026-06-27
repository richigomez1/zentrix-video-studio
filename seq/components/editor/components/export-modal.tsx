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
  /* NEW — for browser export */
  chapterId?: string | null
  chapterProjectName?: string
  chapterNumber?: number
  chapterTitle?: string
}

type ExportMethod = "browser" | "server"
type BrowserPhase = "idle" | "loading-ffmpeg" | "downloading" | "normalizing" | "merging" | "done" | "error"

interface SceneClip {
  index: number
  videoUrl: string
  duration: number
  volume: number
}

const XFADE_DURATION = 1
const TARGET_FPS = 30
const TARGET_WIDTH = 1280
const TARGET_HEIGHT = 720

/* ── Helpers ── */
const getPhaseInfo = (phase: ExportModalProps["exportPhase"], progress: number) => {
  switch (phase) {
    case "init":
      return { label: "Initializing", detail: "Loading FFmpeg engine...", showProgress: false }
    case "audio":
      return { label: "Processing Audio", detail: "Mixing audio tracks and applying effects...", showProgress: true }
    case "video":
      return { label: "Rendering Frames", detail: "Rendering video frames...", showProgress: true }
    case "encoding":
      return { label: "Encoding Video", detail: "Finalizing MP4 file...", showProgress: true }
    case "complete":
      return { label: "Complete", detail: "Export finished!", showProgress: false }
    default:
      return { label: "Preparing", detail: "Getting ready...", showProgress: false }
  }
}

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

/* ── Sub-components ── */
const StepIndicator = memo(function StepIndicator({
  exportPhase,
}: {
  exportPhase: ExportModalProps["exportPhase"]
}) {
  const phases = ["init", "audio", "video", "encoding", "complete"]
  const currentIdx = phases.indexOf(exportPhase)

  return (
    <div className="flex items-center justify-between px-2">
      {(["audio", "video", "encoding"] as const).map((step, idx) => {
        const stepLabels = { audio: "Audio", video: "Video", encoding: "Encode" }
        const stepIdx = phases.indexOf(step)
        const isActive = exportPhase === step
        const isComplete = currentIdx > stepIdx

        return (
          <div key={step} className="flex items-center flex-1">
            <div className="flex flex-col items-center flex-1">
              <div
                className={`
                w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all
                ${
                  isComplete
                    ? "bg-[var(--success)] text-white"
                    : isActive
                      ? "bg-[var(--tertiary)] text-white ring-4 ring-[var(--tertiary)]/30"
                      : "bg-[var(--surface-2)] text-[var(--text-secondary)]"
                }
              `}
              >
                {isComplete ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  idx + 1
                )}
              </div>
              <span
                className={`text-[10px] mt-1.5 font-medium ${isActive ? "text-[var(--tertiary)]" : isComplete ? "text-[var(--success)]" : "text-[var(--text-muted)]"}`}
              >
                {stepLabels[step]}
              </span>
            </div>
            {idx < 2 && (
              <div className={`h-0.5 flex-1 mx-1 ${isComplete ? "bg-[var(--success)]" : "bg-[var(--surface-2)]"}`} />
            )}
          </div>
        )
      })}
    </div>
  )
})

const ResolutionSelector = memo(function ResolutionSelector({
  resolution,
  onSelect,
  hasRenderedPreview,
}: {
  resolution: "720p" | "1080p"
  onSelect: (res: "720p" | "1080p") => void
  hasRenderedPreview: boolean
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        onClick={() => onSelect("1080p")}
        className={`p-3 rounded-lg border text-left transition-all ${resolution === "1080p" ? "bg-[var(--tertiary-muted)] border-[var(--tertiary)]" : "bg-[var(--surface-1)] border-[var(--border-default)] hover:border-[var(--border-emphasis)]"}`}
      >
        <div
          className={`text-sm font-medium ${resolution === "1080p" ? "text-[var(--tertiary)]" : "text-[var(--text-primary)]"}`}
        >
          1080p High
        </div>
        <div className="text-[10px] text-[var(--text-secondary)] mt-1">1920×1080 · Mejor calidad</div>
      </button>
      <button
        onClick={() => onSelect("720p")}
        className={`p-3 rounded-lg border text-left transition-all ${resolution === "720p" ? "bg-[var(--tertiary-muted)] border-[var(--tertiary)]" : "bg-[var(--surface-1)] border-[var(--border-default)] hover:border-[var(--border-emphasis)]"}`}
      >
        <div
          className={`text-sm font-medium ${resolution === "720p" ? "text-[var(--tertiary)]" : "text-[var(--text-primary)]"}`}
        >
          720p Fast
        </div>
        <div className="text-[10px] text-[var(--text-secondary)] mt-1">
          1280×720 · {hasRenderedPreview ? "Export instantáneo" : "Más rápido"}
        </div>
      </button>
    </div>
  )
})

/* ═══════════════════════════════════════════════════════════════
   MAIN EXPORT MODAL
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
  const [isInitializing, setIsInitializing] = useState(false)
  const [exportMethod, setExportMethod] = useState<ExportMethod>("browser")

  /* ── Browser Export State ── */
  const [browserPhase, setBrowserPhase] = useState<BrowserPhase>("idle")
  const [browserProgress, setBrowserProgress] = useState(0)
  const [browserStatus, setBrowserStatus] = useState("")
  const [browserError, setBrowserError] = useState("")
  const [browserDownloadUrl, setBrowserDownloadUrl] = useState<string | null>(null)
  const [browserElapsed, setBrowserElapsed] = useState(0)
  const [browserClipCount, setBrowserClipCount] = useState(0)
  const ffmpegRef = useRef<FFmpeg | null>(null)
  const cancelledRef = useRef(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const startTimeRef = useRef(0)

  const hasBrowserExport = !!chapterId

  // Cleanup
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  // Reset browser state when modal opens
  useEffect(() => {
    if (isOpen) {
      setIsInitializing(false)
      if (browserPhase !== "downloading" && browserPhase !== "normalizing" && browserPhase !== "merging" && browserPhase !== "loading-ffmpeg") {
        setBrowserPhase("idle")
        setBrowserProgress(0)
        setBrowserStatus("")
        setBrowserError("")
      }
    }
  }, [isOpen])

  useEffect(() => {
    if (isExporting) setIsInitializing(false)
  }, [isExporting])

  useEffect(() => {
    if (ffmpegError) setIsInitializing(false)
  }, [ffmpegError])

  /* ── Timer ── */
  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now()
    setBrowserElapsed(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setBrowserElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
  }, [])

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  /* ── Load FFmpeg.wasm (single-threaded, no COOP/COEP headers needed) ── */
  const loadFFmpeg = async (): Promise<FFmpeg> => {
    if (ffmpegRef.current) return ffmpegRef.current
    const ffmpeg = new FFmpeg()
    ffmpeg.on("log", ({ message }) => {
      // console.log("[FFmpeg]", message)
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
          volume: vid.volume ?? 30, // default 30% for sleep content
        })
      }
    }
    clips.sort((a, b) => a.index - b.index)
    if (clips.length === 0) throw new Error("No hay clips con video generado")
    return clips
  }

  /* ══════════════════════════════════════
     BROWSER EXPORT — Main Flow
     ══════════════════════════════════════ */
  const handleBrowserExport = useCallback(async () => {
    cancelledRef.current = false
    setBrowserPhase("loading-ffmpeg")
    setBrowserProgress(0)
    setBrowserStatus("Cargando FFmpeg.wasm (~30 MB, solo la primera vez)...")
    setBrowserError("")
    setBrowserDownloadUrl(null)
    startTimer()

    try {
      // ── Load FFmpeg ──
      const ffmpeg = await loadFFmpeg()
      if (cancelledRef.current) { stopTimer(); return }

      // ── Fetch scene data ──
      setBrowserStatus("Obteniendo datos de escenas...")
      const clips = await fetchSceneClips()
      setBrowserClipCount(clips.length)
      if (cancelledRef.current) { stopTimer(); return }

      // ── Download clips from R2 ──
      setBrowserPhase("downloading")
      for (let i = 0; i < clips.length; i++) {
        if (cancelledRef.current) { stopTimer(); return }
        setBrowserStatus(`Descargando clip ${i + 1} de ${clips.length}...`)
        setBrowserProgress(Math.round((i / clips.length) * 100))

        const response = await fetch(clips[i].videoUrl)
        if (!response.ok) throw new Error(`Error descargando clip ${i + 1}: HTTP ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        await ffmpeg.writeFile(`input_${i}.mp4`, data)
      }

      if (cancelledRef.current) { stopTimer(); return }

      // ── Normalize each clip (fps, resolution, volume, ensure audio) ──
      setBrowserPhase("normalizing")
      setBrowserProgress(0)

      const tw = resolution === "1080p" ? 1920 : TARGET_WIDTH
      const th = resolution === "1080p" ? 1080 : TARGET_HEIGHT

      for (let i = 0; i < clips.length; i++) {
        if (cancelledRef.current) { stopTimer(); return }
        setBrowserStatus(`Normalizando clip ${i + 1} de ${clips.length}...`)
        setBrowserProgress(Math.round((i / clips.length) * 100))

        const vol = clips[i].volume / 100
        const vf = `fps=${TARGET_FPS},scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2,setsar=1`

        // Try with audio first
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
          // Fallback: no audio track — add silent audio
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

        // Free input memory
        try { await ffmpeg.deleteFile(`input_${i}.mp4`) } catch {}
      }

      if (cancelledRef.current) { stopTimer(); return }

      // ── Merge with crossfade (xfade) ──
      setBrowserPhase("merging")
      setBrowserProgress(0)

      if (clips.length === 1) {
        setBrowserStatus("Finalizando video...")
        const d = await ffmpeg.readFile("norm_0.mp4")
        await ffmpeg.writeFile("output.mp4", d)
        try { await ffmpeg.deleteFile("norm_0.mp4") } catch {}
      } else {
        setBrowserStatus(`Uniendo ${clips.length} clips con crossfade...`)

        // Build input args
        const inputArgs: string[] = []
        for (let i = 0; i < clips.length; i++) {
          inputArgs.push("-i", `norm_${i}.mp4`)
        }

        // Build xfade filter chain
        let videoFilter = ""
        let audioFilter = ""
        let cumulativeOffset = 0

        for (let i = 0; i < clips.length - 1; i++) {
          const clipDur = clips[i].duration
          const offset = cumulativeOffset + clipDur - XFADE_DURATION
          const inLabel = i === 0 ? `[${i}:v]` : `[v${i}]`
          const nextLabel = `[${i + 1}:v]`
          const outLabel = i === clips.length - 2 ? "[vout]" : `[v${i + 1}]`

          videoFilter += `${inLabel}${nextLabel}xfade=transition=fade:duration=${XFADE_DURATION}:offset=${offset.toFixed(2)}${outLabel}`
          if (i < clips.length - 2) videoFilter += ";"

          const aInLabel = i === 0 ? `[${i}:a]` : `[a${i}]`
          const aNextLabel = `[${i + 1}:a]`
          const aOutLabel = i === clips.length - 2 ? "[aout]" : `[a${i + 1}]`

          audioFilter += `${aInLabel}${aNextLabel}acrossfade=d=${XFADE_DURATION}:c1=tri:c2=tri${aOutLabel}`
          if (i < clips.length - 2) audioFilter += ";"

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
            "-y", "output.mp4",
          ])
        } catch (xfadeErr) {
          // Fallback: simple concat if xfade fails
          console.warn("xfade failed, falling back to concat:", xfadeErr)
          setBrowserStatus("Crossfade falló — usando concat simple...")

          let concatList = ""
          for (let i = 0; i < clips.length; i++) {
            concatList += `file 'norm_${i}.mp4'\n`
          }
          const encoder = new TextEncoder()
          await ffmpeg.writeFile("concat.txt", encoder.encode(concatList))

          await ffmpeg.exec([
            "-f", "concat", "-safe", "0", "-i", "concat.txt",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            "-y", "output.mp4",
          ])
        }

        // Clean up normalized clips
        for (let i = 0; i < clips.length; i++) {
          try { await ffmpeg.deleteFile(`norm_${i}.mp4`) } catch {}
        }
      }

      if (cancelledRef.current) { stopTimer(); return }

      // ── Create download URL ──
      setBrowserStatus("Preparando descarga...")
      const outputData = await ffmpeg.readFile("output.mp4")
      const blob = new Blob([outputData], { type: "video/mp4" })
      const url = URL.createObjectURL(blob)
      try { await ffmpeg.deleteFile("output.mp4") } catch {}

      setBrowserDownloadUrl(url)
      setBrowserPhase("done")
      setBrowserProgress(100)
      setBrowserStatus("¡Exportación completa!")
      stopTimer()
    } catch (err: unknown) {
      if (cancelledRef.current) { stopTimer(); return }
      const msg = err instanceof Error ? err.message : "Error desconocido"
      console.error("Browser export error:", err)
      setBrowserPhase("error")
      setBrowserError(msg)
      stopTimer()
    }
  }, [chapterId, resolution, startTimer, stopTimer])

  const handleBrowserCancel = useCallback(() => {
    cancelledRef.current = true
    setBrowserPhase("idle")
    setBrowserProgress(0)
    setBrowserStatus("")
    stopTimer()
  }, [stopTimer])

  const handleBrowserDownload = useCallback(() => {
    if (!browserDownloadUrl) return
    const a = document.createElement("a")
    a.href = browserDownloadUrl
    const safeName = `${chapterProjectName || "zentrix"}_cap${chapterNumber || 1}`.replace(/[^a-zA-Z0-9_-]/g, "_")
    a.download = `${safeName}.mp4`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [browserDownloadUrl, chapterProjectName, chapterNumber])

  /* ── Server export handlers (unchanged) ── */
  const handleStartClick = useCallback(async () => {
    if (exportMethod === "browser") {
      handleBrowserExport()
    } else {
      setIsInitializing(true)
      onStartExport(resolution)
    }
  }, [exportMethod, handleBrowserExport, onStartExport, resolution])

  const handleResolutionChange = useCallback((res: "720p" | "1080p") => {
    setResolution(res)
  }, [])

  const handleClose = useCallback(() => {
    if (browserPhase === "downloading" || browserPhase === "normalizing" || browserPhase === "merging" || browserPhase === "loading-ffmpeg") {
      if (!confirm("¿Cancelar la exportación en progreso?")) return
      cancelledRef.current = true
      stopTimer()
    }
    setBrowserPhase("idle")
    onClose()
  }, [browserPhase, onClose, stopTimer])

  if (!isOpen) return null

  const willReusePreview = hasRenderedPreview && resolution === "720p"
  const phaseInfo = getPhaseInfo(exportPhase, exportProgress)

  const isBrowserWorking = browserPhase === "loading-ffmpeg" || browserPhase === "downloading" || browserPhase === "normalizing" || browserPhase === "merging"

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--surface-0)] border border-[var(--border-default)] rounded-xl shadow-2xl w-[520px] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="h-14 px-6 flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--surface-0)]">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider">Exportar Video</h3>
          <button
            onClick={handleClose}
            className="text-[var(--text-secondary)] hover:text-white transition-colors"
            disabled={isExporting}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* ════════════════════════════════════════════════
             BROWSER EXPORT — Active states
             ════════════════════════════════════════════════ */}
          {exportMethod === "browser" && isBrowserWorking ? (
            <div className="flex flex-col gap-4 py-2">
              {/* Phase label */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="animate-pulse text-lg">💻</span>
                  <div>
                    <p className="text-sm font-medium text-white">
                      {browserPhase === "loading-ffmpeg" && "Cargando motor de video..."}
                      {browserPhase === "downloading" && "Descargando clips..."}
                      {browserPhase === "normalizing" && "Normalizando clips..."}
                      {browserPhase === "merging" && "Uniendo con transiciones..."}
                    </p>
                    <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">{browserStatus}</p>
                  </div>
                </div>
                <span className="text-xs text-[var(--text-secondary)] font-mono">{formatTime(browserElapsed)}</span>
              </div>

              {/* Progress bar */}
              <div className="space-y-1.5">
                <div className="h-2 w-full bg-[var(--surface-2)] rounded-full overflow-hidden">
                  {browserPhase === "loading-ffmpeg" ? (
                    <div className="h-full bg-[var(--tertiary-muted)] w-full animate-pulse" />
                  ) : (
                    <div
                      className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300 rounded-full"
                      style={{ width: `${browserProgress}%` }}
                    />
                  )}
                </div>
                {browserPhase !== "loading-ffmpeg" && (
                  <div className="flex justify-end">
                    <span className="text-xs text-cyan-400 font-medium">{browserProgress}%</span>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="text-[10px] text-[var(--text-secondary)] flex items-center gap-3">
                <span>🖥 Procesando en tu computadora</span>
                <span>·</span>
                <span>{browserClipCount} clips</span>
                <span>·</span>
                <span>{resolution}</span>
              </div>

              <button
                onClick={handleBrowserCancel}
                className="mt-1 text-sm text-[var(--error)] hover:text-[var(--error-hover)] transition-colors"
              >
                Cancelar
              </button>
            </div>

          ) : exportMethod === "browser" && browserPhase === "done" && browserDownloadUrl ? (
            /* ── Browser Export Complete ── */
            <div className="flex flex-col items-center gap-4 py-4 animate-in zoom-in-95">
              <div className="w-16 h-16 rounded-full bg-[var(--success-muted)] text-[var(--success)] flex items-center justify-center mb-2">
                <CheckCircleIcon className="w-8 h-8" />
              </div>
              <h4 className="text-lg font-semibold text-white">¡Exportación completa!</h4>
              <p className="text-xs text-[var(--text-secondary)]">
                {browserClipCount} clips con crossfade · {resolution} · {formatTime(browserElapsed)}
              </p>

              <a
                onClick={(e) => { e.preventDefault(); handleBrowserDownload() }}
                href="#"
                className="mt-2 w-full flex items-center justify-center gap-2 px-6 py-3 bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg font-medium transition-all shadow-lg cursor-pointer"
              >
                <DownloadIcon className="w-4 h-4" />
                Descargar MP4
              </a>

              {/* Preview */}
              <video
                src={browserDownloadUrl}
                controls
                className="w-full rounded-lg border border-[var(--border-default)] mt-1"
                style={{ maxHeight: "180px" }}
              />

              <button onClick={handleClose} className="text-sm text-[var(--text-secondary)] hover:text-white">
                Cerrar
              </button>
            </div>

          ) : exportMethod === "browser" && browserPhase === "error" ? (
            /* ── Browser Export Error ── */
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="w-16 h-16 rounded-full bg-[var(--error-muted)] text-[var(--error)] flex items-center justify-center mb-2">
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                </svg>
              </div>
              <h4 className="text-lg font-semibold text-white">Error en exportación</h4>
              <p className="text-sm text-[var(--text-tertiary)] text-center max-w-sm">{browserError}</p>
              <div className="flex gap-3 mt-2">
                <button
                  onClick={() => { setBrowserPhase("idle"); setBrowserError("") }}
                  className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white rounded-lg text-sm transition-colors"
                >
                  Volver
                </button>
                <button
                  onClick={handleBrowserExport}
                  className="px-4 py-2 bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg text-sm transition-colors"
                >
                  Reintentar
                </button>
              </div>
            </div>

          /* ════════════════════════════════════════════════
             SERVER EXPORT — Active states (unchanged logic)
             ════════════════════════════════════════════════ */
          ) : ffmpegError ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="w-16 h-16 rounded-full bg-[var(--error-muted)] text-[var(--error)] flex items-center justify-center mb-2">
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                </svg>
              </div>
              <h4 className="text-lg font-semibold text-white">Export Unavailable</h4>
              <p className="text-sm text-[var(--text-tertiary)] text-center max-w-sm">{ffmpegError}</p>
              <div className="flex gap-3 mt-2">
                <button onClick={handleClose} className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white rounded-lg text-sm transition-colors">
                  Close
                </button>
                <button onClick={() => { setIsInitializing(true); onStartExport(resolution) }} className="px-4 py-2 bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg text-sm transition-colors">
                  Try Again
                </button>
              </div>
            </div>

          ) : downloadUrl ? (
            <div className="flex flex-col items-center gap-4 py-4 animate-in zoom-in-95">
              <div className="w-16 h-16 rounded-full bg-[var(--success-muted)] text-[var(--success)] flex items-center justify-center mb-2">
                <CheckCircleIcon className="w-8 h-8" />
              </div>
              <h4 className="text-lg font-semibold text-white">Export Complete!</h4>
              <a href={downloadUrl} download="project_export.mp4" className="mt-2 w-full flex items-center justify-center gap-2 px-6 py-3 bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg font-medium transition-all shadow-lg">
                <DownloadIcon className="w-4 h-4" />
                Download MP4
              </a>
              <button onClick={handleClose} className="text-sm text-[var(--text-secondary)] hover:text-white">Close</button>
            </div>

          ) : isExporting || isInitializing ? (
            <div className="flex flex-col gap-5 py-4">
              <StepIndicator exportPhase={exportPhase} />
              <div className="text-center">
                <p className="text-sm font-medium text-white">{phaseInfo.label}</p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">{phaseInfo.detail}</p>
              </div>
              <div className="space-y-2">
                <div className="h-2 w-full bg-[var(--surface-2)] rounded-full overflow-hidden">
                  {exportPhase === "init" ? (
                    <div className="h-full bg-[var(--tertiary-muted)] w-full animate-pulse" />
                  ) : (
                    <div className="h-full bg-[var(--tertiary)] transition-all duration-300" style={{ width: `${exportProgress}%` }} />
                  )}
                </div>
                {phaseInfo.showProgress && (
                  <div className="flex justify-end">
                    <span className="text-xs text-[var(--tertiary)] font-medium">{Math.round(exportProgress)}%</span>
                  </div>
                )}
              </div>
              <button onClick={onCancel} className="mt-1 text-sm text-[var(--error)] hover:text-[var(--error-hover)] transition-colors">
                Cancel Export
              </button>
            </div>

          ) : (
            /* ════════════════════════════════════════════════
               PRE-EXPORT — Resolution + Method selection
               ════════════════════════════════════════════════ */
            <div className="flex flex-col gap-5">
              {/* Preview warning */}
              {!hasRenderedPreview && (
                <div className="p-4 rounded-lg bg-[var(--warning-muted)] border border-[var(--warning)]/30 flex items-start gap-3">
                  <svg className="w-5 h-5 text-[var(--warning)] shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <div>
                    <p className="text-sm text-[var(--warning)] font-medium">Preview no renderizado</p>
                    <p className="text-xs text-[var(--warning)]/80 mt-1">
                      Puedes usar <span className="font-semibold">Render</span> en el timeline para previsualizar antes de exportar.
                    </p>
                  </div>
                </div>
              )}

              {hasRenderedPreview && resolution === "720p" && (
                <div className="p-4 rounded-lg bg-[var(--success-muted)] border border-[var(--success)]/30 flex items-start gap-3">
                  <CheckCircleIcon className="w-5 h-5 text-[var(--success)] shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm text-[var(--success)] font-medium">Listo para export rápido</p>
                    <p className="text-xs text-[var(--success)]/80 mt-1">
                      Tu preview renderizado se reutilizará. El export será instantáneo.
                    </p>
                  </div>
                </div>
              )}

              {/* Resolution */}
              <div className="space-y-3">
                <label className="text-xs font-bold text-[var(--text-secondary)] uppercase">Calidad</label>
                <ResolutionSelector
                  resolution={resolution}
                  onSelect={handleResolutionChange}
                  hasRenderedPreview={hasRenderedPreview}
                />
              </div>

              {/* Export Method — only show if browser export is available */}
              {hasBrowserExport && (
                <div className="space-y-3">
                  <label className="text-xs font-bold text-[var(--text-secondary)] uppercase">Método</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => setExportMethod("browser")}
                      className={`p-3 rounded-lg border text-left transition-all ${
                        exportMethod === "browser"
                          ? "bg-cyan-500/10 border-cyan-500"
                          : "bg-[var(--surface-1)] border-[var(--border-default)] hover:border-[var(--border-emphasis)]"
                      }`}
                    >
                      <div className={`text-sm font-medium ${exportMethod === "browser" ? "text-cyan-400" : "text-[var(--text-primary)]"}`}>
                        💻 En mi PC
                      </div>
                      <div className="text-[10px] text-[var(--text-secondary)] mt-1">
                        Crossfade real · Sin servidor
                      </div>
                    </button>
                    <button
                      onClick={() => setExportMethod("server")}
                      className={`p-3 rounded-lg border text-left transition-all ${
                        exportMethod === "server"
                          ? "bg-[var(--tertiary-muted)] border-[var(--tertiary)]"
                          : "bg-[var(--surface-1)] border-[var(--border-default)] hover:border-[var(--border-emphasis)]"
                      }`}
                    >
                      <div className={`text-sm font-medium ${exportMethod === "server" ? "text-[var(--tertiary)]" : "text-[var(--text-primary)]"}`}>
                        ☁️ Servidor
                      </div>
                      <div className="text-[10px] text-[var(--text-secondary)] mt-1">
                        Render procesa · Concat simple
                      </div>
                    </button>
                  </div>
                </div>
              )}

              {/* Chapter info (browser export) */}
              {exportMethod === "browser" && chapterProjectName && (
                <div className="flex items-center justify-between text-[10px] p-2.5 rounded-lg bg-[var(--surface-1)] border border-[var(--border-default)]">
                  <span className="text-[var(--text-secondary)]">
                    {chapterProjectName} · Cap {chapterNumber}: {chapterTitle}
                  </span>
                  <span className="text-cyan-400 font-medium">FFmpeg.wasm</span>
                </div>
              )}

              {/* Start button */}
              <button
                onClick={handleStartClick}
                className={`w-full py-3 font-bold rounded-lg transition-colors shadow-lg mt-1 flex items-center justify-center gap-2 ${
                  exportMethod === "browser"
                    ? "bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white"
                    : "bg-white text-black hover:bg-gray-200"
                }`}
              >
                {exportMethod === "browser"
                  ? "💻 Exportar en mi PC"
                  : willReusePreview
                    ? "Export Now"
                    : "Start Export"
                }
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

ExportModal.displayName = "ExportModal"
