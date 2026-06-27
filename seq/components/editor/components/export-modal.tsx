"use client"

import { memo, useState, useEffect, useCallback, useRef } from "react"
import { DownloadIcon, CheckCircleIcon } from "./icons"

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
  audioUrls?: string[]
}

type ExportPhase = "idle" | "loading" | "processing" | "finalizing" | "done" | "error"

interface SceneClip {
  index: number
  videoUrl: string
  duration: number
  volume: number
}

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
        <div className={`text-sm font-medium ${resolution === "1080p" ? "text-[var(--tertiary)]" : "text-[var(--text-primary)]"}`}>1080p</div>
        <div className="text-[10px] text-[var(--text-secondary)] mt-1">1920×1080 · Mejor calidad</div>
      </button>
      <button
        onClick={() => onSelect("720p")}
        className={`p-3 rounded-lg border text-left transition-all ${resolution === "720p" ? "bg-[var(--tertiary-muted)] border-[var(--tertiary)]" : "bg-[var(--surface-1)] border-[var(--border-default)] hover:border-[var(--border-emphasis)]"}`}
      >
        <div className={`text-sm font-medium ${resolution === "720p" ? "text-[var(--tertiary)]" : "text-[var(--text-primary)]"}`}>720p</div>
        <div className="text-[10px] text-[var(--text-secondary)] mt-1">1280×720 · Más rápido</div>
      </button>
    </div>
  )
})

/* ═══════════════════════════════════════════════════════════════
   EXPORT MODAL — Web Worker powered
   Export runs in a background thread. User can close modal
   and keep editing. A floating bar shows progress.
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
  audioUrls,
}: ExportModalProps) {
  const [resolution, setResolution] = useState<"720p" | "1080p">("1080p")

  /* ── Export State ── */
  const [phase, setPhase] = useState<ExportPhase>("idle")
  const [progress, setProgress] = useState(0)
  const [statusMsg, setStatusMsg] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const [localDownloadUrl, setLocalDownloadUrl] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [clipCount, setClipCount] = useState(0)
  const [totalMB, setTotalMB] = useState("")
  const workerRef = useRef<Worker | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const startTimeRef = useRef(0)

  // Cleanup
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      workerRef.current?.terminate()
    }
  }, [])

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

  /* ── Start export via Web Worker ── */
  const handleExport = useCallback(async () => {
    setPhase("loading")
    setProgress(0)
    setStatusMsg("Preparando...")
    setErrorMsg("")
    setLocalDownloadUrl(null)
    setTotalMB("")
    startTimer()

    try {
      // Fetch scene data on main thread (needs localStorage auth)
      const clips = await fetchSceneClips()
      setClipCount(clips.length)

      // Create Web Worker
      if (workerRef.current) workerRef.current.terminate()
      const worker = new Worker(
        new URL("./export-worker.ts", import.meta.url),
        { type: "module" }
      )
      workerRef.current = worker

      // Listen for worker messages
      worker.onmessage = (e) => {
        const msg = e.data

        if (msg.type === "progress") {
          setPhase(msg.phase as ExportPhase)
          setProgress(msg.progress)
          setStatusMsg(msg.status)
        }

        if (msg.type === "done") {
          stopTimer()
          const blob = new Blob([msg.buffer], { type: "video/mp4" })
          const url = URL.createObjectURL(blob)
          setLocalDownloadUrl(url)
          setTotalMB(msg.totalMB)
          setClipCount(msg.clipCount)
          setPhase("done")
          setProgress(100)
          setStatusMsg(`${msg.clipCount} clips · ${resolution} · ${msg.totalMB} MB`)
          worker.terminate()
          workerRef.current = null
        }

        if (msg.type === "error") {
          stopTimer()
          setPhase("error")
          setErrorMsg(msg.error)
          worker.terminate()
          workerRef.current = null
        }
      }

      worker.onerror = (e) => {
        stopTimer()
        setPhase("error")
        setErrorMsg(`Worker error: ${e.message}`)
        workerRef.current = null
      }

      // Send start command to worker
      worker.postMessage({
        type: "start",
        clips,
        resolution,
        audioUrls: audioUrls || [],
      })
    } catch (err: unknown) {
      stopTimer()
      const msg = err instanceof Error ? err.message : "Error desconocido"
      setPhase("error")
      setErrorMsg(msg)
    }
  }, [chapterId, resolution, audioUrls, startTimer, stopTimer])

  const handleCancel = useCallback(() => {
    workerRef.current?.postMessage({ type: "cancel" })
    workerRef.current?.terminate()
    workerRef.current = null
    setPhase("idle")
    setProgress(0)
    setStatusMsg("")
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
    // If exporting, just close the modal — worker keeps running in background
    // The floating bar will show progress
    onClose()
  }, [onClose])

  const handleStartClick = useCallback(() => {
    if (chapterId) {
      handleExport()
    } else {
      onStartExport(resolution)
    }
  }, [chapterId, handleExport, onStartExport, resolution])

  const isWorking = phase === "loading" || phase === "processing" || phase === "finalizing"

  /* ═══════════════════════════════════════════════
     FLOATING PROGRESS BAR — shown when modal is
     closed but export is still running
     ═══════════════════════════════════════════════ */
  if (!isOpen && (isWorking || phase === "done")) {
    return (
      <div className="fixed bottom-4 right-4 z-[90] animate-in slide-in-from-bottom-4">
        <div className="bg-[var(--surface-0)] border border-[var(--border-default)] rounded-xl shadow-2xl p-4 w-[320px]">
          {isWorking ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-white">Exportando...</span>
                <span className="text-[10px] text-[var(--text-secondary)] font-mono">{formatTime(elapsed)}</span>
              </div>
              <div className="text-[10px] text-[var(--text-secondary)] mb-2">{statusMsg}</div>
              <div className="h-1.5 w-full bg-[var(--surface-2)] rounded-full overflow-hidden mb-2">
                <div className="h-full bg-[var(--tertiary)] transition-all duration-300 rounded-full" style={{ width: `${progress}%` }} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[var(--text-secondary)]">{clipCount} clips · {resolution} · {progress}%</span>
                <button onClick={handleCancel} className="text-[10px] text-[var(--error)] hover:text-[var(--error-hover)]">
                  Cancelar
                </button>
              </div>
            </>
          ) : phase === "done" ? (
            <>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-[var(--success-muted)] text-[var(--success)] flex items-center justify-center">
                  <CheckCircleIcon className="w-4 h-4" />
                </div>
                <span className="text-xs font-medium text-white">¡Exportación completa!</span>
              </div>
              <button
                onClick={handleDownload}
                className="w-full py-2 text-xs font-medium bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg flex items-center justify-center gap-1.5"
              >
                <DownloadIcon className="w-3.5 h-3.5" /> Descargar MP4 ({totalMB} MB)
              </button>
            </>
          ) : null}
        </div>
      </div>
    )
  }

  // Not open and not working — render nothing
  if (!isOpen) return null

  /* ═══════════════════════════════════════════════
     FULL MODAL
     ═══════════════════════════════════════════════ */
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--surface-0)] border border-[var(--border-default)] rounded-xl shadow-2xl w-[500px] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="h-14 px-6 flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--surface-0)]">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider">Exportar Video</h3>
          <button onClick={handleClose} className="text-[var(--text-secondary)] hover:text-white transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {isWorking ? (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">
                    {phase === "loading" && "Preparando..."}
                    {phase === "processing" && "Procesando clips..."}
                    {phase === "finalizing" && "Finalizando..."}
                  </p>
                  <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">{statusMsg}</p>
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
                <div className="flex justify-between">
                  <span className="text-[10px] text-[var(--text-secondary)]">{clipCount} clips · {resolution}</span>
                  <span className="text-xs text-[var(--tertiary)] font-medium">{progress}%</span>
                </div>
              </div>

              {/* Tip: user can close and keep working */}
              <div className="text-[10px] text-[var(--text-muted)] text-center mt-1">
                Puedes cerrar esta ventana y seguir editando. La exportación continuará.
              </div>

              <button onClick={handleCancel} className="mt-1 text-sm text-[var(--error)] hover:text-[var(--error-hover)] transition-colors">
                Cancelar
              </button>
            </div>

          ) : phase === "done" && localDownloadUrl ? (
            <div className="flex flex-col items-center gap-4 py-4 animate-in zoom-in-95">
              <div className="w-16 h-16 rounded-full bg-[var(--success-muted)] text-[var(--success)] flex items-center justify-center mb-2">
                <CheckCircleIcon className="w-8 h-8" />
              </div>
              <h4 className="text-lg font-semibold text-white">¡Exportación completa!</h4>
              <p className="text-xs text-[var(--text-secondary)]">{statusMsg} · {formatTime(elapsed)}</p>

              <button
                onClick={handleDownload}
                className="mt-2 w-full flex items-center justify-center gap-2 px-6 py-3 bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg font-medium transition-all shadow-lg cursor-pointer"
              >
                <DownloadIcon className="w-4 h-4" /> Descargar MP4
              </button>

              <video src={localDownloadUrl} controls className="w-full rounded-lg border border-[var(--border-default)] mt-1" style={{ maxHeight: "200px" }} />
              <button onClick={handleClose} className="text-sm text-[var(--text-secondary)] hover:text-white">Cerrar</button>
            </div>

          ) : phase === "error" ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="w-16 h-16 rounded-full bg-[var(--error-muted)] text-[var(--error)] flex items-center justify-center mb-2">
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
                </svg>
              </div>
              <h4 className="text-lg font-semibold text-white">Error en la exportación</h4>
              <p className="text-sm text-[var(--text-tertiary)] text-center max-w-sm break-words">{errorMsg}</p>
              <div className="flex gap-3 mt-2">
                <button onClick={() => { setPhase("idle"); setErrorMsg("") }} className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white rounded-lg text-sm transition-colors">Volver</button>
                <button onClick={handleExport} className="px-4 py-2 bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-lg text-sm transition-colors">Reintentar</button>
              </div>
            </div>

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
              <div className="text-center"><p className="text-sm font-medium text-white">Exportando...</p></div>
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
