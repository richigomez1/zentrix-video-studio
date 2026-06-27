"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { FFmpeg } from "@ffmpeg/ffmpeg"
import { toBlobURL } from "@ffmpeg/util"

/* ── Types ── */
export interface ExportableScene {
  index: number
  videoUrl: string
  volume: number   // 0-200
  duration: number // seconds
}

interface BrowserExportDialogProps {
  isOpen: boolean
  onClose: () => void
  scenes: ExportableScene[]
  projectName: string
  chapterTitle: string
  chapterNumber: number
}

type ExportPhase = "idle" | "loading-ffmpeg" | "downloading" | "normalizing" | "merging" | "done" | "error"

const XFADE_DURATION = 1 // seconds of crossfade between clips
const TARGET_FPS = 30
const TARGET_WIDTH = 1280
const TARGET_HEIGHT = 720

/* ── Component ── */
export function BrowserExportDialog({
  isOpen,
  onClose,
  scenes,
  projectName,
  chapterTitle,
  chapterNumber,
}: BrowserExportDialogProps) {
  const [phase, setPhase] = useState<ExportPhase>("idle")
  const [progress, setProgress] = useState(0)
  const [statusMsg, setStatusMsg] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  const ffmpegRef = useRef<FFmpeg | null>(null)
  const cancelledRef = useRef(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const startTimeRef = useRef(0)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (downloadUrl) URL.revokeObjectURL(downloadUrl)
    }
  }, [downloadUrl])

  // Timer
  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now()
    setElapsedSec(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
  }, [])

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, "0")}`
  }

  /* ── Load FFmpeg.wasm (single-threaded, no COOP/COEP needed) ── */
  const loadFFmpeg = async (): Promise<FFmpeg> => {
    if (ffmpegRef.current) return ffmpegRef.current

    const ffmpeg = new FFmpeg()

    ffmpeg.on("progress", ({ progress: p }) => {
      // Only update during merging phase (normalization tracks its own progress)
      if (phase === "merging" || !phase) {
        setProgress(Math.min(99, Math.round(p * 100)))
      }
    })

    ffmpeg.on("log", ({ message }) => {
      // Debug: uncomment to see all ffmpeg logs
      // console.log("[FFmpeg]", message)
    })

    // Single-threaded core — works without SharedArrayBuffer / COOP/COEP headers
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd"
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      // No workerURL = single-threaded mode
    })

    ffmpegRef.current = ffmpeg
    return ffmpeg
  }

  /* ── Main Export Flow ── */
  const handleExport = useCallback(async () => {
    cancelledRef.current = false
    setPhase("loading-ffmpeg")
    setProgress(0)
    setStatusMsg("Cargando FFmpeg.wasm (~30 MB, solo la primera vez)...")
    setErrorMsg("")
    setDownloadUrl(null)
    startTimer()

    const validScenes = scenes.filter((s) => s.videoUrl)
    if (validScenes.length === 0) {
      setPhase("error")
      setErrorMsg("No hay escenas con video para exportar.")
      stopTimer()
      return
    }

    try {
      // ── Phase 1: Load FFmpeg ──
      const ffmpeg = await loadFFmpeg()
      if (cancelledRef.current) { stopTimer(); return }

      // ── Phase 2: Download clips from R2 ──
      setPhase("downloading")
      const totalClips = validScenes.length

      for (let i = 0; i < totalClips; i++) {
        if (cancelledRef.current) { stopTimer(); return }
        setStatusMsg(`Descargando clip ${i + 1} de ${totalClips}...`)
        setProgress(Math.round((i / totalClips) * 100))

        const response = await fetch(validScenes[i].videoUrl)
        if (!response.ok) throw new Error(`Error descargando clip ${i + 1}: HTTP ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        await ffmpeg.writeFile(`input_${i}.mp4`, data)
      }

      if (cancelledRef.current) { stopTimer(); return }

      // ── Phase 3: Normalize each clip (30fps, 720p, volume, ensure audio) ──
      setPhase("normalizing")
      setProgress(0)

      for (let i = 0; i < totalClips; i++) {
        if (cancelledRef.current) { stopTimer(); return }
        setStatusMsg(`Normalizando clip ${i + 1} de ${totalClips}...`)
        setProgress(Math.round((i / totalClips) * 100))

        const vol = validScenes[i].volume / 100
        const vf = `fps=${TARGET_FPS},scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`

        // Try with audio first; if clip has no audio track, fallback adds silent audio
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
          // Verify file was created (exec doesn't always throw on filter errors)
          try { await ffmpeg.readFile(`norm_${i}.mp4`); normOk = true } catch { normOk = false }
        } catch { normOk = false }

        if (!normOk) {
          // Fallback: clip has no audio — add silent audio track
          await ffmpeg.exec([
            "-i", `input_${i}.mp4`,
            "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
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

      // ── Phase 4: Merge with crossfade (xfade) ──
      setPhase("merging")
      setProgress(0)

      if (totalClips === 1) {
        // Single clip — just rename
        setStatusMsg("Finalizando video...")
        const data = await ffmpeg.readFile("norm_0.mp4")
        await ffmpeg.writeFile("output.mp4", data)
        try { await ffmpeg.deleteFile("norm_0.mp4") } catch {}
      } else {
        // Build xfade filter chain
        setStatusMsg(`Uniendo ${totalClips} clips con crossfade...`)

        // Build input args
        const inputArgs: string[] = []
        for (let i = 0; i < totalClips; i++) {
          inputArgs.push("-i", `norm_${i}.mp4`)
        }

        // Build video xfade chain
        // [0:v][1:v]xfade=transition=fade:duration=1:offset=O0[v01];
        // [v01][2:v]xfade=transition=fade:duration=1:offset=O1[v012]; ...
        let videoFilter = ""
        let audioFilter = ""
        let cumulativeOffset = 0

        for (let i = 0; i < totalClips - 1; i++) {
          const clipDur = validScenes[i].duration
          const offset = cumulativeOffset + clipDur - XFADE_DURATION
          const inLabel = i === 0 ? `[${i}:v]` : `[v${i}]`
          const nextLabel = `[${i + 1}:v]`
          const outLabel = i === totalClips - 2 ? "[vout]" : `[v${i + 1}]`

          videoFilter += `${inLabel}${nextLabel}xfade=transition=fade:duration=${XFADE_DURATION}:offset=${offset.toFixed(2)}${outLabel}`
          if (i < totalClips - 2) videoFilter += ";"

          // Audio crossfade chain
          const aInLabel = i === 0 ? `[${i}:a]` : `[a${i}]`
          const aNextLabel = `[${i + 1}:a]`
          const aOutLabel = i === totalClips - 2 ? "[aout]" : `[a${i + 1}]`

          audioFilter += `${aInLabel}${aNextLabel}acrossfade=d=${XFADE_DURATION}:c1=tri:c2=tri${aOutLabel}`
          if (i < totalClips - 2) audioFilter += ";"

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
          setStatusMsg("Crossfade falló — usando concat simple...")

          // Write concat list
          let concatList = ""
          for (let i = 0; i < totalClips; i++) {
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
        for (let i = 0; i < totalClips; i++) {
          try { await ffmpeg.deleteFile(`norm_${i}.mp4`) } catch {}
        }
      }

      if (cancelledRef.current) { stopTimer(); return }

      // ── Phase 5: Read output and create download URL ──
      setStatusMsg("Preparando descarga...")
      const outputData = await ffmpeg.readFile("output.mp4")
      const blob = new Blob([outputData], { type: "video/mp4" })
      const url = URL.createObjectURL(blob)

      // Cleanup
      try { await ffmpeg.deleteFile("output.mp4") } catch {}

      setDownloadUrl(url)
      setPhase("done")
      setProgress(100)
      setStatusMsg("¡Exportación completa!")
      stopTimer()
    } catch (err: unknown) {
      if (cancelledRef.current) { stopTimer(); return }
      const msg = err instanceof Error ? err.message : "Error desconocido"
      console.error("Browser export error:", err)
      setPhase("error")
      setErrorMsg(msg)
      stopTimer()
    }
  }, [scenes, startTimer, stopTimer])

  const handleCancel = useCallback(() => {
    cancelledRef.current = true
    setPhase("idle")
    setProgress(0)
    setStatusMsg("")
    stopTimer()
  }, [stopTimer])

  const handleDownload = useCallback(() => {
    if (!downloadUrl) return
    const a = document.createElement("a")
    a.href = downloadUrl
    const safeName = `${projectName}_cap${chapterNumber}`.replace(/[^a-zA-Z0-9_-]/g, "_")
    a.download = `${safeName}.mp4`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [downloadUrl, projectName, chapterNumber])

  const handleClose = useCallback(() => {
    if (phase !== "idle" && phase !== "done" && phase !== "error") {
      if (!confirm("¿Cancelar la exportación en progreso?")) return
      cancelledRef.current = true
    }
    stopTimer()
    setPhase("idle")
    setProgress(0)
    setStatusMsg("")
    setErrorMsg("")
    onClose()
  }, [phase, onClose, stopTimer])

  if (!isOpen) return null

  const doneScenes = scenes.filter((s) => s.videoUrl)
  const totalDuration = doneScenes.reduce((sum, s) => sum + s.duration, 0)
  const estimatedMinutes = Math.max(1, Math.ceil(doneScenes.length * 0.3)) // rough estimate

  const phaseLabels: Record<ExportPhase, string> = {
    "idle": "Listo para exportar",
    "loading-ffmpeg": "Cargando motor de video...",
    "downloading": "Descargando clips...",
    "normalizing": "Normalizando clips...",
    "merging": "Uniendo con transiciones...",
    "done": "¡Completo!",
    "error": "Error",
  }

  const isWorking = phase !== "idle" && phase !== "done" && phase !== "error"

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-[#12121a] border border-[var(--border-default)] rounded-2xl w-[520px] max-w-[95vw] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              💻 Exportar en mi PC
            </h2>
            <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
              FFmpeg.wasm — Todo el procesamiento ocurre en tu navegador
            </p>
          </div>
          <button
            onClick={handleClose}
            className="text-[var(--text-tertiary)] hover:text-white text-lg transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {/* Project info */}
          <div className="flex items-center justify-between text-[11px] mb-4 p-3 rounded-lg bg-[var(--surface-1)] border border-[var(--border-default)]">
            <div>
              <div className="text-white font-medium">{projectName}</div>
              <div className="text-[var(--text-tertiary)]">Cap {chapterNumber}: {chapterTitle}</div>
            </div>
            <div className="text-right">
              <div className="text-white font-medium">{doneScenes.length} clips</div>
              <div className="text-[var(--text-tertiary)]">~{totalDuration}s total</div>
            </div>
          </div>

          {/* Phase-specific content */}
          {phase === "idle" && (
            <div className="space-y-3">
              <div className="text-[11px] text-[var(--text-tertiary)] space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-green-400">✓</span> Crossfade de 1s entre escenas
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-green-400">✓</span> Volumen por escena aplicado
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-green-400">✓</span> Resolución: 720p @ 30fps
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-blue-400">ℹ</span> Tiempo estimado: ~{estimatedMinutes}-{estimatedMinutes * 2} minutos
                </div>
              </div>

              <button
                onClick={handleExport}
                disabled={doneScenes.length === 0}
                className="w-full py-3 text-sm font-bold text-white bg-green-600 hover:bg-green-500 rounded-xl transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
              >
                🚀 Iniciar exportación ({doneScenes.length} clips)
              </button>
            </div>
          )}

          {isWorking && (
            <div className="space-y-3">
              {/* Status */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-amber-300 animate-pulse">{phaseLabels[phase]}</span>
                <span className="text-[var(--text-tertiary)] font-mono">{formatTime(elapsedSec)}</span>
              </div>

              {/* Detail */}
              <div className="text-[10px] text-[var(--text-tertiary)]">{statusMsg}</div>

              {/* Progress bar */}
              <div className="w-full h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="text-[10px] text-[var(--text-tertiary)] text-center">{progress}%</div>

              {/* Cancel */}
              <button
                onClick={handleCancel}
                className="w-full py-2 text-xs font-medium text-red-400 border border-red-800 hover:bg-red-900/30 rounded-lg transition-colors"
              >
                ✕ Cancelar
              </button>
            </div>
          )}

          {phase === "done" && downloadUrl && (
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-2 text-green-400 text-sm font-bold py-2">
                ✅ ¡Exportación completa!
              </div>
              <div className="flex items-center justify-between text-[10px] text-[var(--text-tertiary)]">
                <span>{doneScenes.length} clips unidos con crossfade</span>
                <span className="font-mono">{formatTime(elapsedSec)}</span>
              </div>

              <button
                onClick={handleDownload}
                className="w-full py-3 text-sm font-bold text-white bg-emerald-500 hover:bg-emerald-400 rounded-xl transition-colors flex items-center justify-center gap-2 animate-pulse"
              >
                ⬇️ Descargar Video .mp4
              </button>

              {/* Preview */}
              <video
                src={downloadUrl}
                controls
                className="w-full rounded-lg border border-[var(--border-default)]"
                style={{ maxHeight: "200px" }}
              />
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-red-400 text-sm font-bold py-2">
                ❌ Error en la exportación
              </div>
              <div className="text-[11px] text-red-300 bg-red-900/20 border border-red-800/50 rounded-lg p-3 font-mono break-all">
                {errorMsg}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleExport}
                  className="flex-1 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
                >
                  🔄 Reintentar
                </button>
                <button
                  onClick={handleClose}
                  className="flex-1 py-2 text-xs font-medium text-[var(--text-tertiary)] border border-[var(--border-default)] hover:text-white rounded-lg transition-colors"
                >
                  Cerrar
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer — tech info */}
        <div className="px-6 py-3 border-t border-[var(--border-default)] text-[9px] text-[var(--text-tertiary)]">
          Motor: FFmpeg.wasm (WebAssembly) · Sin servidor · El video nunca sale de tu computadora
        </div>
      </div>
    </div>
  )
}
