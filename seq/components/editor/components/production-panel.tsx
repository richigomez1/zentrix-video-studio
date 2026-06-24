"use client"

import { memo, useState, useEffect, useCallback, useRef } from "react"
import type { ZentrixEditorData, ZentrixScene } from "./zentrix-panel"

const BACKEND_URL =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:8000"
    : "https://zentrix-backend-mcvk.onrender.com"

const TOKEN_KEY = "zentrix_token"

/* ── Model Database ── */
interface ModelInfo {
  id: string
  name: string
  durations: number[]
  price720: number
  price1080: number
  emoji: string
  tier: string
}

const MODELS: ModelInfo[] = [
  { id: "ken-burns", name: "Ken Burns", durations: [5, 8, 10, 12, 15], price720: 0, price1080: 0, emoji: "🎞", tier: "Gratis" },
  { id: "pruna-video", name: "PrunaAI", durations: [5, 10], price720: 0.02, price1080: 0.04, emoji: "🎬", tier: "$" },
  { id: "seedance-1-pro-fast", name: "SD 1.0 Fast", durations: [4, 6, 8, 12], price720: 0.025, price1080: 0.06, emoji: "⚡", tier: "$" },
  { id: "seedance-1.5-pro", name: "SD 1.5 Pro", durations: [5, 8, 10, 12], price720: 0.052, price1080: 0.10, emoji: "🎥", tier: "$$" },
  { id: "seedance-2.0-fast", name: "SD 2.0 Fast", durations: [5, 8, 10, 15], price720: 0.15, price1080: 0.30, emoji: "🔥", tier: "$$$" },
  { id: "seedance-2.0", name: "SD 2.0", durations: [5, 8, 10, 15], price720: 0.18, price1080: 0.45, emoji: "💫", tier: "$$$$" },
  { id: "veo-3.1-lite-generate-preview", name: "Veo Lite", durations: [5, 8], price720: 0.05, price1080: 0.08, emoji: "✨", tier: "$$" },
  { id: "veo-3.1-fast-generate-preview", name: "Veo Fast", durations: [5, 8], price720: 0.10, price1080: 0.12, emoji: "🚀", tier: "$$$" },
  { id: "veo-3.1-generate-preview", name: "Veo Full", durations: [5, 8], price720: 0.40, price1080: 0.40, emoji: "💎", tier: "$$$$" },
]

const MODEL_MAP = Object.fromEntries(MODELS.map((m) => [m.id, m]))

type Resolution = "720p" | "1080p"

/* ── Scene State ── */
interface SceneState {
  index: number
  model: string
  duration: number
  resolution: Resolution
  motionPrompt: string
  classification: string
  status: "pending" | "ready" | "generating" | "done" | "error"
  videoUrl: string | null
  errorMsg: string
}

function getPrice(modelId: string, duration: number, resolution: Resolution): number {
  const m = MODEL_MAP[modelId]
  if (!m) return 0
  const perSec = resolution === "1080p" ? m.price1080 : m.price720
  return perSec * duration
}

function getValidDuration(modelId: string, currentDuration: number): number {
  const m = MODEL_MAP[modelId]
  if (!m) return 8
  if (m.durations.includes(currentDuration)) return currentDuration
  return m.durations.reduce((prev, curr) =>
    Math.abs(curr - currentDuration) < Math.abs(prev - currentDuration) ? curr : prev
  )
}

/* ── API Helper ── */
async function apiFetch(path: string, opts: RequestInit = {}) {
  const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : ""
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(BACKEND_URL + path, { ...opts, headers })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || `Error ${res.status}`)
  return data
}

/* ── Props ── */
export interface ProductionPanelProps {
  isOpen: boolean
  onClose: () => void
  chapterData: ZentrixEditorData | null
  chapterId: string | null
  onVideoGenerated: (sceneIndex: number, videoUrl: string) => void
}

/* ── Scene Card ── */
function SceneCard({
  scene,
  sceneData,
  onChange,
  onGenerate,
}: {
  scene: SceneState
  sceneData: ZentrixScene
  onChange: (updates: Partial<SceneState>) => void
  onGenerate: () => void
}) {
  const model = MODEL_MAP[scene.model]
  const cost = getPrice(scene.model, scene.duration, scene.resolution)
  const hasPrompt = scene.motionPrompt.trim().length > 0

  return (
    <div className={`rounded-xl border transition-all ${
      scene.status === "done" ? "border-green-500/40 bg-green-500/5" :
      scene.status === "generating" ? "border-amber-500/40 bg-amber-500/5" :
      scene.status === "error" ? "border-red-500/40 bg-red-500/5" :
      hasPrompt ? "border-indigo-500/30 bg-indigo-500/5" :
      "border-[var(--border-default)] bg-[var(--surface-1)]"
    }`}>
      {/* Top: Image + Video preview side by side */}
      <div className="flex gap-2 p-3 pb-2">
        {/* Image thumbnail */}
        <div className="w-28 h-20 rounded-lg overflow-hidden bg-[var(--surface-2)] flex-shrink-0 relative">
          {sceneData.image_url ? (
            <img src={sceneData.image_url} alt={`Escena ${scene.index + 1}`} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[var(--text-tertiary)] text-xs">
              Sin imagen
            </div>
          )}
          <div className="absolute top-1 left-1 bg-black/70 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
            E{scene.index + 1}
          </div>
          {scene.classification && (
            <div className="absolute bottom-1 left-1 bg-black/70 text-[9px] px-1.5 py-0.5 rounded text-blue-300">
              {scene.classification === "landscape" ? "🏔 Paisaje" :
               scene.classification === "character" ? "🧑 Personaje" : "🎭 Complejo"}
            </div>
          )}
        </div>

        {/* Video preview or status */}
        <div className="w-28 h-20 rounded-lg overflow-hidden bg-[var(--surface-2)] flex-shrink-0 flex items-center justify-center">
          {scene.status === "done" && scene.videoUrl ? (
            <video
              src={scene.videoUrl}
              className="w-full h-full object-cover"
              muted
              loop
              playsInline
              onMouseEnter={(e) => (e.target as HTMLVideoElement).play()}
              onMouseLeave={(e) => { const v = e.target as HTMLVideoElement; v.pause(); v.currentTime = 0 }}
            />
          ) : scene.status === "generating" ? (
            <div className="text-center">
              <div className="text-lg animate-spin">⏳</div>
              <div className="text-[8px] text-amber-400 mt-1">Generando...</div>
            </div>
          ) : scene.status === "error" ? (
            <div className="text-center px-2">
              <div className="text-lg">❌</div>
              <div className="text-[8px] text-red-400 mt-1 line-clamp-2">{scene.errorMsg || "Error"}</div>
            </div>
          ) : (
            <div className="text-center">
              <div className="text-lg opacity-30">🎬</div>
              <div className="text-[8px] text-[var(--text-tertiary)]">Sin video</div>
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      <div className="px-3 pb-1">
        <div className="text-[10px] text-[var(--text-tertiary)] line-clamp-2">
          {sceneData.text_excerpt || sceneData.image_prompt || "Sin descripción"}
        </div>
      </div>

      {/* Motion Prompt */}
      <div className="px-3 pb-2">
        <label className="text-[9px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
          Motion Prompt {hasPrompt ? "✅" : ""}
        </label>
        <textarea
          value={scene.motionPrompt}
          onChange={(e) => onChange({ motionPrompt: e.target.value })}
          placeholder="GLM 5.2 escribirá el prompt al auto-preparar..."
          rows={2}
          disabled={scene.status === "generating" || scene.status === "done"}
          className="w-full mt-1 px-2 py-1.5 text-[11px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded-lg text-white placeholder:text-[var(--text-tertiary)] resize-none focus:border-indigo-500/50 focus:outline-none disabled:opacity-50"
        />
      </div>

      {/* Controls: Model + Duration + Resolution */}
      <div className="px-3 pb-2 flex gap-1.5">
        <select
          value={scene.model}
          onChange={(e) => {
            const newModel = e.target.value
            const newDur = getValidDuration(newModel, scene.duration)
            onChange({ model: newModel, duration: newDur })
          }}
          disabled={scene.status === "generating" || scene.status === "done"}
          className="flex-1 px-1.5 py-1 text-[10px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded text-white disabled:opacity-50"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>
          ))}
        </select>

        <select
          value={scene.duration}
          onChange={(e) => onChange({ duration: parseInt(e.target.value) })}
          disabled={scene.status === "generating" || scene.status === "done"}
          className="w-14 px-1 py-1 text-[10px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded text-white text-center disabled:opacity-50"
        >
          {(MODEL_MAP[scene.model]?.durations || [8]).map((d) => (
            <option key={d} value={d}>{d}s</option>
          ))}
        </select>

        <select
          value={scene.resolution}
          onChange={(e) => onChange({ resolution: e.target.value as Resolution })}
          disabled={scene.status === "generating" || scene.status === "done"}
          className="w-16 px-1 py-1 text-[10px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded text-white text-center disabled:opacity-50"
        >
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
        </select>
      </div>

      {/* Bottom: Cost + Generate */}
      <div className="px-3 pb-3 flex items-center justify-between">
        <span className={`text-xs font-bold ${cost === 0 ? "text-green-400" : cost < 1 ? "text-blue-400" : "text-amber-400"}`}>
          ${cost.toFixed(3)}
        </span>

        {scene.status === "pending" || scene.status === "ready" || scene.status === "error" ? (
          <button
            onClick={onGenerate}
            disabled={!hasPrompt && scene.model !== "ken-burns"}
            className="px-3 py-1 text-[10px] font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ▶ Generar
          </button>
        ) : scene.status === "done" ? (
          <span className="text-[10px] text-green-400 font-medium">✅ Listo</span>
        ) : (
          <span className="text-[10px] text-amber-400 animate-pulse">⏳ Generando...</span>
        )}
      </div>
    </div>
  )
}

/* ── Main Production Panel (Fullscreen Modal) ── */
export const ProductionPanel = memo(function ProductionPanel({
  isOpen,
  onClose,
  chapterData,
  chapterId,
  onVideoGenerated,
}: ProductionPanelProps) {
  const [scenes, setScenes] = useState<SceneState[]>([])
  const [globalModel, setGlobalModel] = useState("pruna-video")
  const [globalDuration, setGlobalDuration] = useState(10)
  const [globalResolution, setGlobalResolution] = useState<Resolution>("720p")
  const [isAutoPreparing, setIsAutoPreparing] = useState(false)
  const [isBatchGenerating, setIsBatchGenerating] = useState(false)
  const [statusMsg, setStatusMsg] = useState("")
  const [autoPrepareDone, setAutoPrepareDone] = useState(false)
  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const mountedRef = useRef(true)

  // Initialize scenes from chapter data
  useEffect(() => {
    if (!chapterData) return
    const initial: SceneState[] = chapterData.scenes
      .filter((s) => s.image_url)
      .map((s) => ({
        index: s.index,
        model: s.video_url ? (s.video_model || "ken-burns") : "pruna-video",
        duration: 10,
        resolution: "720p" as Resolution,
        motionPrompt: "",
        classification: "",
        status: s.video_url ? "done" as const : "pending" as const,
        videoUrl: s.video_url || null,
        errorMsg: "",
      }))
    setScenes(initial)
    setAutoPrepareDone(false)
  }, [chapterData])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [])

  const applyGlobalToAll = useCallback(() => {
    setScenes((prev) =>
      prev.map((s) => {
        if (s.status === "done" || s.status === "generating") return s
        const dur = getValidDuration(globalModel, globalDuration)
        return { ...s, model: globalModel, duration: dur, resolution: globalResolution }
      })
    )
  }, [globalModel, globalDuration, globalResolution])

  const updateScene = useCallback((index: number, updates: Partial<SceneState>) => {
    setScenes((prev) =>
      prev.map((s) => (s.index === index ? { ...s, ...updates } : s))
    )
  }, [])

  /* ── Auto-preparar: GLM 5.2 analiza imágenes ── */
  const handleAutoPrepare = useCallback(async () => {
    if (!chapterId) return
    setIsAutoPreparing(true)
    setStatusMsg("🤖 GLM 5.2 está analizando cada imagen...")

    try {
      const result = await apiFetch(
        `/api/image-studio/chapters/${chapterId}/auto-prepare-videos`,
        {
          method: "POST",
          body: JSON.stringify({
            default_duration: globalDuration,
            default_resolution: globalResolution,
          }),
        }
      )

      if (!mountedRef.current) return

      if (result.scenes && Array.isArray(result.scenes)) {
        setScenes((prev) =>
          prev.map((s) => {
            const prepared = result.scenes.find((r: any) => r.index === s.index)
            if (!prepared || s.status === "done") return s
            return {
              ...s,
              model: prepared.model || s.model,
              motionPrompt: prepared.motion_prompt || s.motionPrompt,
              classification: prepared.classification || "",
              duration: getValidDuration(prepared.model || s.model, globalDuration),
              resolution: globalResolution,
              status: "ready" as const,
            }
          })
        )
        setAutoPrepareDone(true)
        setStatusMsg(`✅ ${result.scenes.length} escenas preparadas. Revisa los motion prompts y genera.`)
      } else {
        setStatusMsg("⚠️ Respuesta inesperada del servidor")
      }
    } catch (e: unknown) {
      if (!mountedRef.current) return
      setStatusMsg(`❌ Error: ${e instanceof Error ? e.message : "Error desconocido"}`)
    } finally {
      if (mountedRef.current) setIsAutoPreparing(false)
    }
  }, [chapterId, globalDuration, globalResolution])

  /* ── Generate single scene ── */
  const generateScene = useCallback(async (sceneIndex: number) => {
    if (!chapterId) return
    const scene = scenes.find((s) => s.index === sceneIndex)
    if (!scene) return

    updateScene(sceneIndex, { status: "generating", errorMsg: "" })

    try {
      await apiFetch(`/api/image-studio/chapters/${chapterId}/animate-scene`, {
        method: "POST",
        body: JSON.stringify({
          segment_index: sceneIndex,
          video_model: scene.model,
          duration_seconds: scene.duration,
          resolution: scene.resolution,
          motion_prompt: scene.motionPrompt,
        }),
      })
      startPolling()
    } catch (e: unknown) {
      updateScene(sceneIndex, {
        status: "error",
        errorMsg: e instanceof Error ? e.message : "Error al enviar",
      })
    }
  }, [chapterId, scenes, updateScene])

  /* ── Batch Generate ── */
  const handleBatchGenerate = useCallback(async () => {
    if (!chapterId) return
    const pendingScenes = scenes.filter(
      (s) => (s.status === "pending" || s.status === "ready") && (s.motionPrompt.trim() || s.model === "ken-burns")
    )
    if (pendingScenes.length === 0) {
      setStatusMsg("⚠️ No hay escenas listas. Auto-prepara primero.")
      return
    }

    setIsBatchGenerating(true)
    setStatusMsg(`🚀 Enviando ${pendingScenes.length} escenas...`)

    setScenes((prev) =>
      prev.map((s) => {
        const isPending = pendingScenes.some((p) => p.index === s.index)
        return isPending ? { ...s, status: "generating" as const } : s
      })
    )

    let sent = 0
    for (const scene of pendingScenes) {
      try {
        await apiFetch(`/api/image-studio/chapters/${chapterId}/animate-scene`, {
          method: "POST",
          body: JSON.stringify({
            segment_index: scene.index,
            video_model: scene.model,
            duration_seconds: scene.duration,
            resolution: scene.resolution,
            motion_prompt: scene.motionPrompt,
          }),
        })
        sent++
        if (mountedRef.current) {
          setStatusMsg(`🚀 Enviada ${sent}/${pendingScenes.length}...`)
        }
      } catch (e: unknown) {
        updateScene(scene.index, {
          status: "error",
          errorMsg: e instanceof Error ? e.message : "Error al enviar",
        })
      }
      await new Promise((r) => setTimeout(r, 300))
    }

    if (mountedRef.current) {
      setStatusMsg(`✅ ${sent} escenas enviadas. Generando videos...`)
      setIsBatchGenerating(false)
      startPolling()
    }
  }, [chapterId, scenes, updateScene])

  /* ── Polling ── */
  const startPolling = useCallback(() => {
    if (pollingRef.current || !chapterId) return
    pollingRef.current = setInterval(async () => {
      if (!mountedRef.current || !chapterId) {
        if (pollingRef.current) clearInterval(pollingRef.current)
        pollingRef.current = null
        return
      }

      try {
        const data = await apiFetch(`/api/image-studio/chapters/${chapterId}/video-progress`)
        if (!data.videos || !mountedRef.current) return

        let hasGenerating = false

        setScenes((prev) =>
          prev.map((s) => {
            if (s.status !== "generating") return s
            const vid = data.videos.find((v: any) => v.segment_index === s.index)
            if (!vid) { hasGenerating = true; return s }

            const isKB = s.model === "ken-burns"
            const status = isKB ? vid.kb_status : vid.veo_status
            const url = isKB ? vid.kb_url : vid.veo_url

            if (status === "done" && url) {
              onVideoGenerated(s.index, url)
              return { ...s, status: "done" as const, videoUrl: url }
            }
            if (status === "error") {
              return { ...s, status: "error" as const, errorMsg: vid.error_message || "Error de generación" }
            }
            hasGenerating = true
            return s
          })
        )

        if (!hasGenerating && pollingRef.current) {
          clearInterval(pollingRef.current)
          pollingRef.current = null
          if (mountedRef.current) setStatusMsg("✅ Todos los videos completados")
        }
      } catch {
        // Silent polling error
      }
    }, 8000)
  }, [chapterId, onVideoGenerated])

  if (!isOpen || !chapterData) return null

  const pendingCount = scenes.filter((s) => s.status === "pending" || s.status === "ready").length
  const generatingCount = scenes.filter((s) => s.status === "generating").length
  const doneCount = scenes.filter((s) => s.status === "done").length
  const errorCount = scenes.filter((s) => s.status === "error").length
  const totalCost = scenes
    .filter((s) => s.status !== "done")
    .reduce((sum, s) => sum + getPrice(s.model, s.duration, s.resolution), 0)
  const readyToGenerate = scenes.filter(
    (s) => (s.status === "ready" || s.status === "pending") && (s.motionPrompt.trim() || s.model === "ken-burns")
  ).length

  return (
    <div className="fixed inset-0 z-50 bg-[#0a0a0f] flex flex-col">
      {/* ═══ HEADER ═══ */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--border-default)] bg-[var(--surface-0)]">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-sm font-bold text-white">
              🎬 Producción — {chapterData.project_name}
            </h1>
            <p className="text-[10px] text-[var(--text-tertiary)]">
              Cap {chapterData.chapter_number}: {chapterData.chapter_title} — {scenes.length} escenas con imagen
            </p>
          </div>
        </div>

        {/* Global Controls */}
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <label className="text-[8px] text-[var(--text-tertiary)] uppercase mb-0.5">Modelo global</label>
            <select
              value={globalModel}
              onChange={(e) => setGlobalModel(e.target.value)}
              className="px-2 py-1 text-[10px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded text-white"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.emoji} {m.name} ({m.tier})</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[8px] text-[var(--text-tertiary)] uppercase mb-0.5">Duración</label>
            <select
              value={globalDuration}
              onChange={(e) => setGlobalDuration(parseInt(e.target.value))}
              className="px-2 py-1 text-[10px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded text-white"
            >
              {(MODEL_MAP[globalModel]?.durations || [5, 8, 10]).map((d) => (
                <option key={d} value={d}>{d}s</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[8px] text-[var(--text-tertiary)] uppercase mb-0.5">Resolución</label>
            <select
              value={globalResolution}
              onChange={(e) => setGlobalResolution(e.target.value as Resolution)}
              className="px-2 py-1 text-[10px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded text-white"
            >
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
            </select>
          </div>

          <button
            onClick={applyGlobalToAll}
            className="px-3 py-1.5 text-[10px] font-medium text-white bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border-default)] rounded-lg transition-colors mt-2.5"
          >
            Aplicar a todas
          </button>

          <button
            onClick={onClose}
            className="ml-4 px-3 py-1.5 text-[10px] font-medium text-[var(--text-tertiary)] hover:text-white border border-[var(--border-default)] hover:border-red-500 rounded-lg transition-colors mt-2.5"
          >
            ✕ Cerrar
          </button>
        </div>
      </div>

      {/* ═══ ACTION BAR ═══ */}
      <div className="flex items-center justify-between px-6 py-2.5 border-b border-[var(--border-default)] bg-[var(--surface-1)]">
        <div className="flex items-center gap-4 text-[10px]">
          <span className="text-[var(--text-tertiary)]">{scenes.length} escenas</span>
          {doneCount > 0 && <span className="text-green-400">✅ {doneCount} listas</span>}
          {generatingCount > 0 && <span className="text-amber-400 animate-pulse">⏳ {generatingCount} generando</span>}
          {errorCount > 0 && <span className="text-red-400">❌ {errorCount} errores</span>}
          <span className="text-[var(--text-tertiary)]">⏸ {pendingCount} pendientes</span>
          <span className="text-white font-bold text-xs">Costo: ${totalCost.toFixed(2)}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleAutoPrepare}
            disabled={isAutoPreparing || isBatchGenerating}
            className="px-4 py-2 text-xs font-medium text-white bg-purple-600 hover:bg-purple-500 rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            {isAutoPreparing ? (
              <><span className="animate-spin">🤖</span> GLM analizando...</>
            ) : (
              <>🤖 Auto-preparar (GLM 5.2)</>
            )}
          </button>

          <button
            onClick={handleBatchGenerate}
            disabled={isBatchGenerating || isAutoPreparing || readyToGenerate === 0}
            className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            {isBatchGenerating ? (
              <><span className="animate-spin">🚀</span> Enviando...</>
            ) : (
              <>🚀 Generar {readyToGenerate > 0 ? `${readyToGenerate} escenas` : "Todos"} (${totalCost.toFixed(2)})</>
            )}
          </button>
        </div>
      </div>

      {/* Status */}
      {statusMsg && (
        <div className="px-6 py-2 bg-[var(--surface-2)] border-b border-[var(--border-default)]">
          <div className="text-xs text-amber-300">{statusMsg}</div>
        </div>
      )}

      {/* ═══ SCENE GRID ═══ */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
          {scenes.map((scene) => {
            const sceneData = chapterData.scenes.find((s) => s.index === scene.index)
            if (!sceneData) return null
            return (
              <SceneCard
                key={scene.index}
                scene={scene}
                sceneData={sceneData}
                onChange={(updates) => updateScene(scene.index, updates)}
                onGenerate={() => generateScene(scene.index)}
              />
            )
          })}
        </div>

        {scenes.length === 0 && (
          <div className="flex items-center justify-center h-64 text-[var(--text-tertiary)]">
            <div className="text-center">
              <div className="text-4xl mb-3 opacity-30">🎬</div>
              <div className="text-sm">No hay escenas con imagen generada</div>
              <div className="text-xs mt-1">Genera las imágenes primero en Image Studio</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

export default ProductionPanel
