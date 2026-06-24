"use client"

import { memo, useState, useEffect, useCallback } from "react"
import type { MediaItem } from "../types"
import { PanelLeftClose } from "./icons"

const BACKEND_URL =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:8000"
    : "https://zentrix-backend-mcvk.onrender.com"

const TOKEN_KEY = "zentrix_token"

const MODELS = [
  { id: "ken-burns", name: "Ken Burns", price: 0, tier: "Gratis", emoji: "🎞" },
  { id: "pruna-video", name: "PrunaAI", price: 0.02, tier: "$", emoji: "🎬" },
  { id: "seedance-1-pro-fast", name: "SD 1.0 Fast", price: 0.025, tier: "$", emoji: "⚡" },
  { id: "seedance-1.5-pro", name: "SD 1.5 Pro", price: 0.052, tier: "$$", emoji: "🎥" },
  { id: "seedance-2.0-fast", name: "SD 2.0 Fast", price: 0.15, tier: "$$$", emoji: "🔥" },
  { id: "seedance-2.0", name: "SD 2.0", price: 0.18, tier: "$$$$", emoji: "💫" },
  { id: "veo-3.1-lite-generate-preview", name: "Veo Lite", price: 0.05, tier: "$$", emoji: "✨" },
  { id: "veo-3.1-fast-generate-preview", name: "Veo Fast", price: 0.10, tier: "$$$", emoji: "🚀" },
  { id: "veo-3.1-generate-preview", name: "Veo Full", price: 0.40, tier: "$$$$", emoji: "💎" },
]

const MODES = {
  economico: { label: "Económico", desc: "Ken Burns + momentos clave con IA", color: "text-green-400", models: ["ken-burns", "pruna-video"] },
  balanceado: { label: "Balanceado", desc: "Mezcla IA + Ken Burns", color: "text-blue-400", models: ["pruna-video", "seedance-1-pro-fast", "seedance-1.5-pro", "veo-3.1-lite-generate-preview"] },
  premium: { label: "Premium", desc: "Máxima calidad, más IA", color: "text-purple-400", models: ["seedance-2.0-fast", "veo-3.1-lite-generate-preview", "veo-3.1-fast-generate-preview", "veo-3.1-generate-preview"] },
}

type Mode = keyof typeof MODES

interface SceneStatus {
  index: number
  model: string
  status: "pending" | "generating" | "done" | "error"
  videoUrl?: string
  cost: number
}

interface ProductionPanelProps {
  onClose: () => void
  media: MediaItem[]
  chapterId: string | null
  onUpdateMedia: (id: string, updates: Partial<MediaItem>) => void
}

async function apiFetch(path: string, opts: RequestInit = {}) {
  const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : ""
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(BACKEND_URL + path, { ...opts, headers })
  return res.json()
}

export const ProductionPanel = memo(function ProductionPanel({
  onClose,
  media,
  chapterId,
  onUpdateMedia,
}: ProductionPanelProps) {
  const [mode, setMode] = useState<Mode>("balanceado")
  const [scenes, setScenes] = useState<SceneStatus[]>([])
  const [generating, setGenerating] = useState(false)
  const [polling, setPolling] = useState(false)
  const [progress, setProgress] = useState("")

  // Initialize scenes from media
  useEffect(() => {
    const imageScenes = media
      .filter((m) => m.type === "image" && m.id.startsWith("zentrix-s"))
      .map((m) => {
        const index = parseInt(m.id.replace("zentrix-s", ""), 10)
        return {
          index,
          model: "ken-burns",
          status: "pending" as const,
          cost: 0,
        }
      })
      .sort((a, b) => a.index - b.index)
    setScenes(imageScenes)
  }, [media])

  // Apply mode to all scenes
  const applyMode = useCallback(
    (m: Mode) => {
      setMode(m)
      const modeModels = MODES[m].models
      setScenes((prev) =>
        prev.map((s, i) => {
          if (s.status === "done" || s.status === "generating") return s
          // Distribute models based on position (important scenes get better models)
          const modelIdx = Math.min(
            Math.floor((i / Math.max(prev.length - 1, 1)) * modeModels.length),
            modeModels.length - 1,
          )
          const model = modeModels[modelIdx]
          const modelInfo = MODELS.find((mod) => mod.id === model)
          const dur = media.find((mm) => mm.id === `zentrix-s${s.index}`)?.duration || 8
          const cost = (modelInfo?.price || 0) * Math.min(dur, 10)
          return { ...s, model, cost }
        }),
      )
    },
    [media],
  )

  // Update individual scene model
  const updateSceneModel = (index: number, model: string) => {
    setScenes((prev) =>
      prev.map((s) => {
        if (s.index !== index) return s
        const modelInfo = MODELS.find((m) => m.id === model)
        const dur = media.find((m) => m.id === `zentrix-s${index}`)?.duration || 8
        const cost = (modelInfo?.price || 0) * Math.min(dur, 10)
        return { ...s, model, cost }
      }),
    )
  }

  // Generate video for a single scene
  const generateScene = async (sceneIndex: number) => {
    if (!chapterId) return
    const scene = scenes.find((s) => s.index === sceneIndex)
    if (!scene) return

    setScenes((prev) => prev.map((s) => (s.index === sceneIndex ? { ...s, status: "generating" } : s)))

    try {
      const mediaItem = media.find((m) => m.id === `zentrix-s${sceneIndex}`)
      const duration = Math.min(mediaItem?.duration || 8, scene.model.startsWith("veo") ? 8 : 12)

      const result = await apiFetch(`/api/image-studio/chapters/${chapterId}/animate-scene`, {
        method: "POST",
        body: JSON.stringify({
          segment_index: sceneIndex,
          video_model: scene.model,
          duration_seconds: duration,
          resolution: "720p",
          motion_prompt: mediaItem?.prompt || "",
        }),
      })

      if (result.ok) {
        startPolling()
      } else {
        setScenes((prev) => prev.map((s) => (s.index === sceneIndex ? { ...s, status: "error" } : s)))
      }
    } catch {
      setScenes((prev) => prev.map((s) => (s.index === sceneIndex ? { ...s, status: "error" } : s)))
    }
  }

  // Generate all pending scenes
  const generateAll = async () => {
    if (!chapterId) return
    setGenerating(true)
    setProgress("Enviando escenas a generar...")

    const pendingScenes = scenes.filter((s) => s.status === "pending")
    let sent = 0

    for (const scene of pendingScenes) {
      setProgress(`Enviando escena ${sent + 1} de ${pendingScenes.length}...`)
      await generateScene(scene.index)
      sent++
      // Small delay between requests
      await new Promise((r) => setTimeout(r, 500))
    }

    setProgress(`✅ ${sent} escenas enviadas. Generando videos...`)
    setGenerating(false)
    startPolling()
  }

  // Poll for video progress
  const startPolling = useCallback(() => {
    if (polling || !chapterId) return
    setPolling(true)
  }, [polling, chapterId])

  useEffect(() => {
    if (!polling || !chapterId) return
    const interval = setInterval(async () => {
      try {
        const data = await apiFetch(`/api/image-studio/chapters/${chapterId}/video-progress`)
        if (data.videos) {
          let allDone = true
          setScenes((prev) =>
            prev.map((s) => {
              const vid = data.videos.find((v: any) => v.segment_index === s.index)
              if (!vid) return s

              const veoStatus = vid.veo_status
              const kbStatus = vid.kb_status

              if (s.model === "ken-burns") {
                if (kbStatus === "done" && vid.kb_url) {
                  onUpdateMedia(`zentrix-s${s.index}`, { url: vid.kb_url, type: "video" })
                  return { ...s, status: "done", videoUrl: vid.kb_url }
                }
                if (kbStatus === "queued" || kbStatus === "processing") {
                  allDone = false
                  return { ...s, status: "generating" }
                }
              } else {
                if (veoStatus === "done" && vid.veo_url) {
                  onUpdateMedia(`zentrix-s${s.index}`, { url: vid.veo_url, type: "video" })
                  return { ...s, status: "done", videoUrl: vid.veo_url }
                }
                if (veoStatus === "queued" || veoStatus === "processing" || veoStatus === "polling") {
                  allDone = false
                  return { ...s, status: "generating" }
                }
                if (veoStatus === "error") {
                  return { ...s, status: "error" }
                }
              }
              if (s.status === "generating") allDone = false
              return s
            }),
          )
          if (allDone && scenes.some((s) => s.status === "generating")) {
            // Keep polling
          } else if (allDone) {
            setPolling(false)
            setProgress("✅ Todos los videos completados")
          }
        }
      } catch (e) {
        console.error("Polling error:", e)
      }
    }, 8000)

    return () => clearInterval(interval)
  }, [polling, chapterId, scenes, onUpdateMedia])

  const totalCost = scenes.reduce((sum, s) => sum + s.cost, 0)
  const doneCount = scenes.filter((s) => s.status === "done").length
  const genCount = scenes.filter((s) => s.status === "generating").length

  if (!chapterId || scenes.length === 0) {
    return (
      <div className="flex h-full w-[320px] flex-col border-r border-[var(--border-default)] bg-[var(--surface-0)]">
        <div className="flex h-10 items-center justify-between border-b border-[var(--border-default)] px-4">
          <span className="text-xs font-semibold text-white">Producción</span>
          <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-white"><PanelLeftClose className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4 text-center">
          <div className="text-xs text-[var(--text-tertiary)]">
            Carga un capítulo desde el panel Zentrix primero. Las imágenes aparecerán aquí para animar.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-[320px] flex-col border-r border-[var(--border-default)] bg-[var(--surface-0)]">
      {/* Header */}
      <div className="flex h-10 items-center justify-between border-b border-[var(--border-default)] px-4">
        <span className="text-xs font-semibold text-white">🎬 Producción</span>
        <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-white"><PanelLeftClose className="h-4 w-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Mode Selector */}
        <div className="p-3 border-b border-[var(--border-default)]">
          <div className="text-[10px] font-medium text-[var(--text-tertiary)] mb-2">MODO DE PRESUPUESTO</div>
          <div className="flex gap-1">
            {(Object.entries(MODES) as [Mode, typeof MODES[Mode]][]).map(([key, m]) => (
              <button
                key={key}
                onClick={() => applyMode(key)}
                className={`flex-1 py-1.5 text-[10px] font-medium rounded-md transition-colors ${
                  mode === key
                    ? `${m.color} bg-white/10 border border-white/20`
                    : "text-[var(--text-tertiary)] hover:text-white border border-transparent"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="text-[9px] text-[var(--text-tertiary)] mt-1">{MODES[mode].desc}</div>
        </div>

        {/* Cost Summary */}
        <div className="p-3 border-b border-[var(--border-default)] bg-[var(--surface-2)]">
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-[var(--text-tertiary)]">{scenes.length} escenas</span>
            <span className="text-sm font-bold text-white">${totalCost.toFixed(2)}</span>
          </div>
          <div className="flex gap-3 mt-1 text-[9px] text-[var(--text-tertiary)]">
            <span>✅ {doneCount} listas</span>
            {genCount > 0 && <span className="text-amber-400">⏳ {genCount} generando</span>}
            <span>⏸ {scenes.length - doneCount - genCount} pendientes</span>
          </div>
        </div>

        {/* Generate All Button */}
        <div className="p-3 border-b border-[var(--border-default)]">
          <button
            onClick={generateAll}
            disabled={generating || scenes.every((s) => s.status !== "pending")}
            className="w-full py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {generating ? "⏳ Enviando..." : `🚀 Generar Todo ($${totalCost.toFixed(2)})`}
          </button>
          {progress && <div className="text-[9px] text-amber-400 mt-2 text-center">{progress}</div>}
        </div>

        {/* Scene List */}
        <div className="p-2">
          {scenes.map((scene) => {
            const mediaItem = media.find((m) => m.id === `zentrix-s${scene.index}`)
            const modelInfo = MODELS.find((m) => m.id === scene.model)

            return (
              <div key={scene.index} className="flex gap-2 p-2 rounded-lg hover:bg-[var(--hover-overlay)] mb-1">
                {/* Thumbnail */}
                <div className="w-12 h-12 rounded overflow-hidden bg-[var(--surface-2)] flex-shrink-0">
                  {mediaItem?.thumbnailUrl && (
                    <img src={mediaItem.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] font-bold text-white">E{scene.index + 1}</span>
                    {scene.status === "done" && <span className="text-[9px] text-green-400">✅</span>}
                    {scene.status === "generating" && <span className="text-[9px] text-amber-400 animate-pulse">⏳</span>}
                    {scene.status === "error" && <span className="text-[9px] text-red-400">❌</span>}
                    <span className="text-[9px] text-[var(--text-tertiary)]">${scene.cost.toFixed(2)}</span>
                  </div>

                  {/* Model selector */}
                  <select
                    value={scene.model}
                    onChange={(e) => updateSceneModel(scene.index, e.target.value)}
                    disabled={scene.status === "generating" || scene.status === "done"}
                    className="w-full mt-1 px-1 py-0.5 text-[9px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded text-white disabled:opacity-50"
                  >
                    {MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.emoji} {m.name} {m.tier}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Generate button */}
                {scene.status === "pending" && (
                  <button
                    onClick={() => generateScene(scene.index)}
                    className="text-[9px] text-indigo-400 hover:text-indigo-300 self-center px-1"
                    title="Generar video"
                  >
                    ▶
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})

export default ProductionPanel
