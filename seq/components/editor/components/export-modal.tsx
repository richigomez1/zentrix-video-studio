"use client"

import { memo, useState, useEffect, useCallback, useRef } from "react"
import { DownloadIcon, CheckCircleIcon } from "./icons"
import {
  subscribe,
  getJobs,
  addExportJob,
  cancelJob,
  downloadJob,
  clearFinishedJobs,
  type ExportJob,
  type ExportClip,
} from "./export-queue"

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

/* ── Helpers ── */
const formatTime = (sec: number) => {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

function elapsed(job: ExportJob): number {
  if (!job.startedAt) return 0
  return Math.floor((Date.now() - job.startedAt) / 1000)
}

async function apiFetch(path: string) {
  const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : ""
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
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

/* ── Status badge color ── */
function statusColor(status: ExportJob["status"]): string {
  switch (status) {
    case "queued": return "text-[var(--text-secondary)]"
    case "loading": case "processing": case "finalizing": return "text-[var(--tertiary)]"
    case "done": return "text-[var(--success)]"
    case "error": return "text-[var(--error)]"
    default: return "text-[var(--text-secondary)]"
  }
}

function statusLabel(status: ExportJob["status"]): string {
  switch (status) {
    case "queued": return "En cola"
    case "loading": return "Preparando..."
    case "processing": return "Procesando"
    case "finalizing": return "Finalizando"
    case "done": return "Completado"
    case "error": return "Error"
    default: return ""
  }
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT MODAL — Queue-powered
   Exports run in a background Web Worker via a global queue.
   User can queue multiple chapters and keep editing.
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
  const [errorMsg, setErrorMsg] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  /* ── Subscribe to global queue state ── */
  const [jobs, setJobs] = useState<ExportJob[]>(getJobs())
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const unsub = subscribe(() => setJobs([...getJobs()]))
    return unsub
  }, [])

  // Timer tick for elapsed time display
  useEffect(() => {
    const hasActive = jobs.some(
      (j) => j.status === "loading" || j.status === "processing" || j.status === "finalizing"
    )
    if (!hasActive) return
    const interval = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [jobs])

  /* ── Fetch clips and add to queue ── */
  const handleExport = useCallback(async () => {
    if (!chapterId) return
    setErrorMsg("")
    setIsSubmitting(true)

    try {
      const data = await apiFetch(`/api/image-studio/chapters/${chapterId}/video-progress`)
      if (!data.videos || !Array.isArray(data.videos)) throw new Error("No videos found")

      const clips: ExportClip[] = []
      for (const vid of data.videos) {
        const url = vid.veo_url || vid.kb_url
        const status = vid.veo_url ? vid.veo_status : vid.kb_status
        if (status === "done" && url) {
          clips.push({
            index: vid.segment_index,
            videoUrl: url,
            duration: vid.duration || 8,
            volume: vid.volume ?? 30,
            meta: vid.veo_url ? vid.veo_meta : vid.kb_meta,
          })
        }
      }
      clips.sort((a, b) => a.index - b.index)
      if (clips.length === 0) throw new Error("No hay clips con video generado")

      // Nombre del archivo = nombre del capítulo (el que se ve en el editor),
      // con el número de capítulo adelante para que ordene bien. Cae al nombre
      // del proyecto solo si el capítulo no tiene título.
      const label = chapterTitle
        ? (chapterNumber ? `Cap${chapterNumber}_${chapterTitle}` : chapterTitle)
        : `${chapterProjectName || "zentrix"}_cap${chapterNumber || 1}`

      addExportJob({
        chapterId,
        chapterLabel: label,
        clips,
        audioUrls: audioUrls || [],
        resolution,
      })

      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error desconocido"
      setErrorMsg(msg)
    } finally {
      setIsSubmitting(false)
    }
  }, [chapterId, resolution, audioUrls, chapterProjectName, chapterNumber, onClose])

  /* ── Derived state ── */
  const activeJobs = jobs.filter(
    (j) => j.status !== "done" && j.status !== "error"
  )
  const finishedJobs = jobs.filter(
    (j) => j.status === "done" || j.status === "error"
  )
  const hasJobs = jobs.length > 0

  /* ═══════════════════════════════════════════════
     FLOATING QUEUE BAR — shown when modal is closed
     but there are jobs (active, queued, or completed)
     ═══════════════════════════════════════════════ */
  if (!isOpen && hasJobs) {
    return (
      <div className="fixed bottom-4 right-4 z-[90] animate-in slide-in-from-bottom-4">
        <div className="bg-[var(--surface-0)] border border-[var(--border-default)] rounded-xl shadow-2xl p-3 w-[340px] max-h-[400px] overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-xs font-bold text-white uppercase tracking-wider">
              Exports{activeJobs.length > 0 ? ` (${activeJobs.length} activo${activeJobs.length > 1 ? "s" : ""})` : ""}
            </span>
            {finishedJobs.length > 0 && (
              <button
                onClick={clearFinishedJobs}
                className="text-[10px] text-[var(--text-secondary)] hover:text-white transition-colors"
              >
                Limpiar
              </button>
            )}
          </div>

          {/* Job list */}
          <div className="space-y-2">
            {jobs.map((job) => {
              const isActive = job.status === "loading" || job.status === "processing" || job.status === "finalizing"
              const el = isActive ? elapsed(job) : 0
              return (
                <div
                  key={job.id}
                  className="p-2.5 rounded-lg bg-[var(--surface-1)] border border-[var(--border-default)]"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-medium text-white truncate max-w-[180px]">
                      {job.chapterLabel}
                    </span>
                    <span className={`text-[10px] font-medium ${statusColor(job.status)}`}>
                      {statusLabel(job.status)}
                      {isActive && ` · ${formatTime(el)}`}
                    </span>
                  </div>

                  {isActive && (
                    <>
                      <div className="text-[10px] text-[var(--text-secondary)] mb-1.5 truncate">{job.statusMsg}</div>
                      <div className="h-1 w-full bg-[var(--surface-2)] rounded-full overflow-hidden mb-1.5">
                        {job.status === "loading" ? (
                          <div className="h-full bg-[var(--tertiary-muted)] w-full animate-pulse" />
                        ) : (
                          <div className="h-full bg-[var(--tertiary)] transition-all duration-300 rounded-full" style={{ width: `${job.progress}%` }} />
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-[var(--text-secondary)]">{job.clipCount} clips · {job.resolution} · {job.progress}%</span>
                        <button
                          onClick={() => cancelJob(job.id)}
                          className="text-[10px] text-[var(--error)] hover:text-[var(--error-hover)]"
                        >
                          Cancelar
                        </button>
                      </div>
                    </>
                  )}

                  {job.status === "queued" && (
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-[var(--text-secondary)]">{job.clipCount} clips · {job.resolution}</span>
                      <button
                        onClick={() => cancelJob(job.id)}
                        className="text-[10px] text-[var(--error)] hover:text-[var(--error-hover)]"
                      >
                        Quitar
                      </button>
                    </div>
                  )}

                  {job.status === "done" && (
                    <button
                      onClick={() => downloadJob(job.id)}
                      className="w-full py-1.5 text-[11px] font-medium bg-[var(--tertiary)] hover:bg-[var(--tertiary-hover)] text-white rounded-md flex items-center justify-center gap-1"
                    >
                      <DownloadIcon className="w-3 h-3" /> Descargar ({job.totalMB} MB)
                    </button>
                  )}

                  {job.status === "error" && (
                    <p className="text-[10px] text-[var(--error)] truncate">{job.error}</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // Not open and no jobs — render nothing
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
          <button onClick={onClose} className="text-[var(--text-secondary)] hover:text-white transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {errorMsg ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="w-16 h-16 rounded-full bg-[var(--error-muted)] text-[var(--error)] flex items-center justify-center mb-2">
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
                </svg>
              </div>
              <h4 className="text-lg font-semibold text-white">Error</h4>
              <p className="text-sm text-[var(--text-tertiary)] text-center max-w-sm break-words">{errorMsg}</p>
              <button onClick={() => setErrorMsg("")} className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white rounded-lg text-sm transition-colors">
                Volver
              </button>
            </div>
          ) : (
            /* ── Pre-export settings ── */
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

              {/* Show queue status if there are active jobs */}
              {activeJobs.length > 0 && (
                <div className="text-[11px] p-3 rounded-lg bg-[var(--surface-1)] border border-[var(--border-default)] text-[var(--text-secondary)]">
                  {activeJobs.length === 1 ? "Hay 1 export en progreso." : `Hay ${activeJobs.length} exports activos.`}
                  {" "}Este se agregará a la cola.
                </div>
              )}

              <button
                onClick={handleExport}
                disabled={isSubmitting}
                className="w-full py-3 bg-white text-black font-bold rounded-lg hover:bg-gray-200 transition-colors shadow-lg mt-2 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isSubmitting ? "Cargando..." : activeJobs.length > 0 ? "Agregar a la cola" : "Exportar"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

ExportModal.displayName = "ExportModal"
