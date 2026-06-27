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

type ExportPhase = "idle" | "loading" | "downloading" | "processing" | "finalizing" | "done" | "error"

interface SceneClip {
  index: number
  videoUrl: string
  duration: number
  volume: number
}

const TARGET_FPS = 30
const FADE_DURATION = 0.7 // seconds of fade-in/fade-out per clip

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
  const [errorMsg, setErrorMsg] = useState("")
  const [localDownloadUrl, setLocalDownloadUrl] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [clipCount, setClipCount] = useState(0)
  const ffmpegRef = useRef<FFmpeg | null>(null)
  const cancelledRef = useRef(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const startTimeRef = useRef(0)
  const lastErrorRef = useRef<string>("")

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  useEffect(() => {
    if (isOpen && phase !== "downloading" && phase !== "processing" && phase !== "finalizing" && phase !== "loading") {
      setPhase("idle")
      setProgress(0)
      setStatusMsg("")
      setErrorMsg("")
    }
  }, [isOpen])

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
    ffmpeg.on("log", ({ message }) => {
      // Capture last error for debugging
      if (message.toLowerCase().includes("error") || message.toLowerCase().includes("invalid")) {
        lastErrorRef.current = message
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

  /* ── Fetch scene clips ── */
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

  /* ══════════════════════════════════════
     EXPORT FLOW
     Strategy: normalize each clip with fade-in/out baked in,
     then instant concat with -c copy (no re-encoding in merge)
     ══════════════════════════════════════ */
  const handleExport = useCallback(async () => {
    cancelledRef.current = false
    lastErrorRef.current = ""
    setPhase("loading")
    setProgress(0)
    setStatusMsg("Preparando...")
    setErrorMsg("")
    setLocalDownloadUrl(null)
    startTimer()

    try {
      const ffmpeg = await loadFFmpeg()
      if (cancelledRef.current) { stopTimer(); return }

      setStatusMsg("Obteniendo escenas...")
      const clips = await fetchSceneClips()
      setClipCount(clips.length)
      if (cancelledRef.current) { stopTimer(); return }

      const tw = resolution === "1080p" ? 1920 : 1280
      const th = resolution === "1080p" ? 1080 : 720

      // ════════════════════════════════════════
      // PHASE 1: Download + Process each clip
      // Download → normalize → fade → delete input → next
      // This keeps memory low (only 1 input + 1 output at a time)
      // ════════════════════════════════════════
      setPhase("processing")
      setProgress(0)

      for (let i = 0; i < clips.length; i++) {
        if (cancelledRef.current) { stopTimer(); return }
        setStatusMsg(`Clip ${i + 1} de ${clips.length} — descargando...`)
        setProgress(Math.round((i / clips.length) * 95))

        // Download
        const response = await fetch(clips[i].videoUrl)
        if (!response.ok) throw new Error(`Error descargando clip ${i + 1}: HTTP ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        await ffmpeg.writeFile(`input_${i}.mp4`, data)

        // Normalize with fade-in/fade-out baked in
        setStatusMsg(`Clip ${i + 1} de ${clips.length} — procesando...`)

        const vol = clips[i].volume / 100
        const isFirst = i === 0
        const isLast = i === clips.length - 1

        // Build video filter: scale + fps + fade
        let vfParts = [
          `fps=${TARGET_FPS}`,
          `scale=${tw}:${th}:force_original_aspect_ratio=decrease`,
          `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2`,
          `setsar=1`,
        ]
        // Add fade-in to first clip or all clips, fade-out to last clip or all clips
        // For smooth transitions between clips: every clip gets fade-out, every clip gets fade-in
        // Exception: first clip no fade-in, last clip no fade-out (video starts/ends clean)
        if (!isFirst) {
          vfParts.push(`fade=t=in:st=0:d=${FADE_DURATION}`)
        }
        if (!isLast) {
          // fade-out needs to know duration — use a very large start time and let ffmpeg figure it out
          // Actually, we need real duration. Use a trick: fade=t=out:d=FADE:st=999 won't work.
          // Instead, use the 'reverse fade' approach or just apply to all clips
          vfParts.push(`fade=t=out:d=${FADE_DURATION}:st=99999`)
          // This won't work because st=99999 is past end. Better approach:
        }

        // Simpler: apply fade-in and fade-out to ALL clips using the 'fade' filter
        // fade=t=out needs st (start time). We don't know exact duration before encoding.
        // Solution: use expression-based start time
        // Actually the simplest reliable approach: apply fade to all clips
        // fade=in:0:FRAMES for fade-in, fade=out:0:FRAMES with start at end
        // In newer ffmpeg: fade=t=out:st='if(gte(t,duration-0.7),1,0)' doesn't work
        // 
        // BEST approach: use -sseof for fade-out timing? No.
        // ACTUALLY: we can use the 'afade' and 'fade' with negative times won't work.
        //
        // The reliable way: just apply fade-in to all and fade-out to all.
        // For fade-out, we DON'T specify st — we specify duration from the END.
        // But fade filter requires st (start time in seconds).
        // 
        // Workaround: use a two-pass approach or just trust the duration from API.
        // Let's use API duration. If clip is 8s, fade-out starts at 8 - FADE_DURATION = 7.3

        // Reset vfParts with proper fade
        const clipDur = clips[i].duration
        vfParts = [
          `fps=${TARGET_FPS}`,
          `scale=${tw}:${th}:force_original_aspect_ratio=decrease`,
          `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2`,
          `setsar=1`,
        ]
        if (!isFirst) {
          vfParts.push(`fade=t=in:st=0:d=${FADE_DURATION}`)
        }
        if (!isLast) {
          const fadeOutStart = Math.max(0, clipDur - FADE_DURATION)
          vfParts.push(`fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${FADE_DURATION}`)
        }

        const vf = vfParts.join(",")

        // Build audio filter
        let af = `volume=${vol.toFixed(2)}`
        if (!isFirst) {
          af += `,afade=t=in:st=0:d=${FADE_DURATION}`
        }
        if (!isLast) {
          const aFadeOutStart = Math.max(0, clipDur - FADE_DURATION)
          af += `,afade=t=out:st=${aFadeOutStart.toFixed(2)}:d=${FADE_DURATION}`
        }

        // Try with audio
        let ok = false
        try {
          await ffmpeg.exec([
            "-i", `input_${i}.mp4`,
            "-vf", vf,
            "-af", af,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
            "-r", String(TARGET_FPS),
            "-y", `clip_${i}.mp4`,
          ])
          // Verify output
          const check = await ffmpeg.readFile(`clip_${i}.mp4`)
          if (check.length > 500) ok = true
        } catch { ok = false }

        if (!ok) {
          // Retry without audio filter (clip may have no audio)
          try {
            await ffmpeg.exec([
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
            const errMsg = e2 instanceof Error ? e2.message : String(e2)
            throw new Error(`Clip ${i + 1} falló: ${errMsg}. FFmpeg: ${lastErrorRef.current}`)
          }
        }

        // Free input immediately
        try { await ffmpeg.deleteFile(`input_${i}.mp4`) } catch {}
      }

      if (cancelledRef.current) { stopTimer(); return }

      // ════════════════════════════════════════
      // PHASE 2: Concat all clips (INSTANT — no re-encoding)
      // ════════════════════════════════════════
      setPhase("finalizing")
      setStatusMsg("Uniendo clips...")
      setProgress(96)

      // Write concat file list
      let concatList = ""
      for (let i = 0; i < clips.length; i++) {
        concatList += `file 'clip_${i}.mp4'\n`
      }
      const encoder = new TextEncoder()
      await ffmpeg.writeFile("concat.txt", encoder.encode(concatList))

      // Concat with stream copy — FAST, no re-encoding
      await ffmpeg.exec([
        "-f", "concat", "-safe", "0", "-i", "concat.txt",
        "-c", "copy",
        "-movflags", "+faststart",
        "-y", "output.mp4",
      ])

      // Clean up clips
      for (let i = 0; i < clips.length; i++) {
        try { await ffmpeg.deleteFile(`clip_${i}.mp4`) } catch {}
      }
      try { await ffmpeg.deleteFile("concat.txt") } catch {}

      if (cancelledRef.current) { stopTimer(); return }

      // ════════════════════════════════════════
      // PHASE 3: Verify + serve download
      // ════════════════════════════════════════
      setStatusMsg("Verificando...")
      setProgress(98)

      const outputData = await ffmpeg.readFile("output.mp4")
      if (outputData.length < 10000) {
        throw new Error(`Archivo muy pequeño (${(outputData.length / 1024).toFixed(0)} KB). FFmpeg: ${lastErrorRef.current}`)
      }

      const blob = new Blob([outputData], { type: "video/mp4" })
      const url = URL.createObjectURL(blob)
      try { await ffmpeg.deleteFile("output.mp4") } catch {}

      const totalMB = (outputData.length / 1024 / 1024).toFixed(1)
      setLocalDownloadUrl(url)
      setPhase("done")
      setProgress(100)
      setStatusMsg(`${clips.length} clips · ${resolution} · ${totalMB} MB`)
      stopTimer()
    } catch (err: unknown) {
      if (cancelledRef.current) { stopTimer(); return }
      const msg = err instanceof Error ? err.message : `Error desconocido. FFmpeg: ${lastErrorRef.current}`
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
    if (phase === "downloading" || phase === "processing" || phase === "finalizing" || phase === "loading") {
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

  const isWorking = phase === "loading" || phase === "downloading" || phase === "processing" || phase === "finalizing"

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
          {isWorking ? (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">
                    {phase === "loading" && "Preparando..."}
                    {phase === "downloading" && "Descargando..."}
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
                <DownloadIcon className="w-4 h-4" />
                Descargar MP4
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
