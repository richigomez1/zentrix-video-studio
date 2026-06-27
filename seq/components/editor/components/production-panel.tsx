"use client"

import { memo, useState, useEffect, useCallback, useRef } from "react"
import type { ZentrixEditorData, ZentrixScene } from "./zentrix-panel"
import { BrowserExportDialog, type ExportableScene } from "./browser-export-dialog"

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
  { id: "ken-burns", name: "Ken Burns", durations: [4, 5, 6, 8, 10, 12, 15], price720: 0, price1080: 0, emoji: "🎞", tier: "Gratis" },
  { id: "pruna-video-draft", name: "PrunaAI Draft", durations: [3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20], price720: 0.005, price1080: 0.01, emoji: "⚡", tier: "¢" },
  { id: "pruna-video", name: "PrunaAI", durations: [3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20], price720: 0.02, price1080: 0.04, emoji: "🎬", tier: "$" },
  { id: "seedance-1-pro-fast", name: "SD 1.0 Fast", durations: [4, 6, 8, 12], price720: 0.025, price1080: 0.06, emoji: "⚡", tier: "$" },
  { id: "seedance-1.5-pro", name: "SD 1.5 Pro", durations: [5, 8, 10, 12], price720: 0.052, price1080: 0.10, emoji: "🎥", tier: "$$" },
  { id: "seedance-2.0-fast", name: "SD 2.0 Fast", durations: [5, 8, 10, 15], price720: 0.15, price1080: 0.30, emoji: "🔥", tier: "$$$" },
  { id: "seedance-2.0", name: "SD 2.0", durations: [5, 8, 10, 15], price720: 0.18, price1080: 0.45, emoji: "💫", tier: "$$$$" },
  { id: "veo-3.1-lite-generate-preview", name: "Veo Lite", durations: [5, 8], price720: 0.05, price1080: 0.08, emoji: "✨", tier: "$$" },
  { id: "veo-3.1-fast-generate-preview", name: "Veo Fast", durations: [5, 8], price720: 0.10, price1080: 0.12, emoji: "🚀", tier: "$$$" },
  { id: "veo-3.1-generate-preview", name: "Veo Full", durations: [5, 8], price720: 0.40, price1080: 0.40, emoji: "💎", tier: "$$$$" },
]

const MODEL_MAP = Object.fromEntries(MODELS.map((m) => [m.id, m]))

/* ── Tier Presets: auto-assign model by duration ── */
type TierName = "economico" | "equilibrado" | "balanceado" | "premium"

const TIER_CONFIG: Record<TierName, { label: string; emoji: string; color: string; description: string; mapping: Record<number, string> }> = {
  economico: {
    label: "Económico",
    emoji: "🟢",
    color: "bg-emerald-600 hover:bg-emerald-500",
    description: "PrunaAI Draft — $0.005/seg",
    mapping: {
      3: "pruna-video-draft",
      4: "pruna-video-draft",
      5: "pruna-video-draft",
      6: "pruna-video-draft",
      7: "pruna-video-draft",
      8: "pruna-video-draft",
      9: "pruna-video-draft",
      10: "pruna-video-draft",
      11: "pruna-video-draft",
      12: "pruna-video-draft",
      13: "pruna-video-draft",
      14: "pruna-video-draft",
      15: "pruna-video-draft",
    },
  },
  equilibrado: {
    label: "Equilibrado",
    emoji: "🟡",
    color: "bg-amber-600 hover:bg-amber-500",
    description: "PrunaAI Normal — $0.02/seg",
    mapping: {
      3: "pruna-video",
      4: "pruna-video",
      5: "pruna-video",
      6: "pruna-video",
      7: "pruna-video",
      8: "pruna-video",
      9: "pruna-video",
      10: "pruna-video",
      11: "pruna-video",
      12: "pruna-video",
      13: "pruna-video",
      14: "pruna-video",
      15: "pruna-video",
    },
  },
  balanceado: {
    label: "Balanceado",
    emoji: "🟠",
    color: "bg-orange-600 hover:bg-orange-500",
    description: "PrunaAI + Veo Lite — mejor calidad",
    mapping: {
      3: "pruna-video",
      4: "pruna-video",
      5: "veo-3.1-lite-generate-preview",
      6: "pruna-video",
      7: "pruna-video",
      8: "veo-3.1-lite-generate-preview",
      9: "pruna-video",
      10: "pruna-video",
      11: "pruna-video",
      12: "pruna-video",
      13: "pruna-video",
      14: "pruna-video",
      15: "pruna-video",
    },
  },
  premium: {
    label: "Premium",
    emoji: "🔴",
    color: "bg-red-600 hover:bg-red-500",
    description: "Veo Fast + Full — máxima calidad",
    mapping: {
      3: "veo-3.1-fast-generate-preview",
      4: "veo-3.1-fast-generate-preview",
      5: "veo-3.1-fast-generate-preview",
      6: "veo-3.1-fast-generate-preview",
      7: "veo-3.1-fast-generate-preview",
      8: "veo-3.1-generate-preview",
      9: "veo-3.1-fast-generate-preview",
      10: "veo-3.1-fast-generate-preview",
      11: "veo-3.1-fast-generate-preview",
      12: "veo-3.1-fast-generate-preview",
      13: "veo-3.1-fast-generate-preview",
      14: "veo-3.1-fast-generate-preview",
      15: "veo-3.1-fast-generate-preview",
    },
  },
}

// All possible durations across all models
const ALL_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20]

type Resolution = "720p" | "1080p"

/* ── Helper: snap raw seconds to nearest standard duration ── */
function snapToStandardDuration(rawSeconds: number): number {
  if (rawSeconds <= 0) return 5
  return ALL_DURATIONS.reduce((prev, curr) =>
    Math.abs(curr - rawSeconds) < Math.abs(prev - rawSeconds) ? curr : prev
  )
}

/* ── Helper: get models that support a specific duration ── */
function getCompatibleModels(duration: number): ModelInfo[] {
  return MODELS.filter((m) => m.durations.includes(duration))
}

/* ── Ken Burns Config ── */
interface KBConfig {
  mode: "standard" | "parallax"
  preset: string | null
  start_zoom: number
  end_zoom: number
  start_x: number
  start_y: number
  end_x: number
  end_y: number
  overlay: "none" | "dust" | "fog" | "rain" | "grain" | "ash"
}

const KB_DEFAULT: KBConfig = { mode: "standard", preset: "zoom_in_center", start_zoom: 100, end_zoom: 110, start_x: 50, start_y: 50, end_x: 50, end_y: 50, overlay: "none" }

const KB_OVERLAYS: { id: KBConfig["overlay"]; label: string; emoji: string }[] = [
  { id: "none",  label: "Sin overlay",  emoji: "⚪" },
  { id: "dust",  label: "Polvo",        emoji: "✨" },
  { id: "fog",   label: "Niebla",       emoji: "🌫" },
  { id: "rain",  label: "Lluvia",       emoji: "🌧" },
  { id: "grain", label: "Grano",        emoji: "🎞" },
  { id: "ash",   label: "Ceniza",       emoji: "🔥" },
]

const KB_PRESETS: { id: string; label: string; emoji: string; config: Omit<KBConfig, "preset"> }[] = [
  { id: "zoom_in_center",  label: "Zoom In",     emoji: "🔍", config: { mode: "standard", start_zoom: 100, end_zoom: 110, start_x: 50, start_y: 50, end_x: 50, end_y: 50, overlay: "none" } },
  { id: "zoom_out_center", label: "Zoom Out",    emoji: "🔭", config: { mode: "standard", start_zoom: 112, end_zoom: 100, start_x: 50, start_y: 50, end_x: 50, end_y: 50, overlay: "none" } },
  { id: "zoom_in_top",     label: "Zoom Arriba", emoji: "⬆️", config: { mode: "standard", start_zoom: 100, end_zoom: 115, start_x: 50, start_y: 25, end_x: 50, end_y: 25, overlay: "none" } },
  { id: "zoom_in_bottom",  label: "Zoom Abajo",  emoji: "⬇️", config: { mode: "standard", start_zoom: 100, end_zoom: 115, start_x: 50, start_y: 75, end_x: 50, end_y: 75, overlay: "none" } },
  { id: "pan_left",        label: "Pan →",       emoji: "➡️", config: { mode: "standard", start_zoom: 112, end_zoom: 112, start_x: 20, start_y: 50, end_x: 80, end_y: 50, overlay: "none" } },
  { id: "pan_right",       label: "Pan ←",       emoji: "⬅️", config: { mode: "standard", start_zoom: 112, end_zoom: 112, start_x: 80, start_y: 50, end_x: 20, end_y: 50, overlay: "none" } },
  { id: "pan_up",          label: "Pan ↑",       emoji: "⏫", config: { mode: "standard", start_zoom: 112, end_zoom: 112, start_x: 50, start_y: 75, end_x: 50, end_y: 25, overlay: "none" } },
  { id: "pan_down",        label: "Pan ↓",       emoji: "⏬", config: { mode: "standard", start_zoom: 112, end_zoom: 112, start_x: 50, start_y: 25, end_x: 50, end_y: 75, overlay: "none" } },
]

/* ── Scene State ── */
interface SceneState {
  index: number
  model: string
  duration: number       // FIXED — snapped from timeline, does not change
  resolution: Resolution
  motionPrompt: string
  classification: string
  kbConfig: KBConfig
  status: "pending" | "ready" | "generating" | "done" | "error"
  videoUrl: string | null
  errorMsg: string
  volume: number         // 0-200, default 100 (percentage)
  jobId: string | null   // for cancel functionality
}

function getPrice(modelId: string, duration: number, resolution: Resolution): number {
  const m = MODEL_MAP[modelId]
  if (!m) return 0
  const perSec = resolution === "1080p" ? m.price1080 : m.price720
  return perSec * duration
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
  savedKBPresets,
  onSaveKBPreset,
  onDeleteKBPreset,
  onApplyKBToAll,
  onChange,
  onGenerate,
  onCancel,
  onDelete,
}: {
  scene: SceneState
  sceneData: ZentrixScene
  savedKBPresets: { name: string; config: KBConfig }[]
  onSaveKBPreset: (name: string, config: KBConfig) => void
  onDeleteKBPreset: (name: string) => void
  onApplyKBToAll: (config: KBConfig) => void
  onChange: (updates: Partial<SceneState>) => void
  onGenerate: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const cost = getPrice(scene.model, scene.duration, scene.resolution)
  const hasPrompt = scene.motionPrompt.trim().length > 0
  const isVeo = scene.model.startsWith("veo-")

  return (
    <div className={`rounded-xl border transition-all ${
      scene.status === "done" ? "border-green-500/40 bg-green-500/5" :
      scene.status === "generating" ? "border-amber-500/40 bg-amber-500/5" :
      scene.status === "error" ? "border-red-500/40 bg-red-500/5" :
      hasPrompt ? "border-indigo-500/30 bg-indigo-500/5" :
      "border-[var(--border-default)] bg-[var(--surface-1)]"
    }`}>
      {/* Top: Image + Video preview */}
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
            <div className="relative w-full h-full group">
              <video
                src={scene.videoUrl}
                className="w-full h-full object-cover"
                muted
                loop
                playsInline
                onMouseEnter={(e) => (e.target as HTMLVideoElement).play()}
                onMouseLeave={(e) => { const v = e.target as HTMLVideoElement; v.pause(); v.currentTime = 0 }}
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center gap-2">
                <button
                  className="hidden group-hover:block text-white text-[10px] font-bold bg-black/60 px-2 py-1 rounded cursor-pointer hover:bg-black/80"
                  onClick={() => window.open(scene.videoUrl!, '_blank')}
                >
                  ▶ Ver
                </button>
                <button
                  className="hidden group-hover:block text-white text-[10px] font-bold bg-red-600/80 px-2 py-1 rounded cursor-pointer hover:bg-red-500"
                  onClick={() => onDelete()}
                >
                  🗑
                </button>
              </div>
            </div>
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

      {/* Duration (FIXED from timeline) + Description */}
      <div className="px-3 pb-1">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-bold text-cyan-400 bg-cyan-400/10 px-2 py-0.5 rounded">
            ⏱ {scene.duration}s
          </span>
          {isVeo && <span className="text-[8px] text-purple-400">Gemini escribe prompt</span>}
          {!isVeo && scene.model !== "ken-burns" && <span className="text-[8px] text-blue-400">Gemini escribe prompt</span>}
        </div>
        <div className="text-[10px] text-[var(--text-tertiary)] line-clamp-2">
          {sceneData.text_excerpt || sceneData.image_prompt || "Sin descripción"}
        </div>
      </div>

      {/* Motion Prompt OR Ken Burns Config */}
      <div className="px-3 pb-2">
        {scene.model === "ken-burns" && scene.status === "done" ? (
          /* ── Ken Burns Done — compact label ── */
          <div className="text-[9px] text-[var(--text-tertiary)]">🎞 Ken Burns aplicado</div>
        ) : scene.model === "ken-burns" ? (
          /* ── Ken Burns Config Panel ── */
          <div>
            <label className="text-[9px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
              🎞 Efecto Ken Burns
            </label>

            {/* Mode toggle: Standard vs Parallax */}
            <div className="flex gap-1 mt-1.5">
              <button
                onClick={() => onChange({ kbConfig: { ...scene.kbConfig, mode: "standard" } })}
                disabled={scene.status === "generating" || scene.status === "done"}
                className={`flex-1 px-2 py-1 text-[9px] rounded-md transition-all ${
                  scene.kbConfig.mode === "standard"
                    ? "bg-emerald-600 text-white"
                    : "bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-white"
                } disabled:opacity-50`}
              >
                🎬 Estándar
              </button>
              <button
                onClick={() => onChange({ kbConfig: { ...scene.kbConfig, mode: "parallax" } })}
                disabled={scene.status === "generating" || scene.status === "done"}
                className={`flex-1 px-2 py-1 text-[9px] rounded-md transition-all ${
                  scene.kbConfig.mode === "parallax"
                    ? "bg-purple-600 text-white"
                    : "bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-white"
                } disabled:opacity-50`}
              >
                🌄 Paralaje 3D
              </button>
            </div>

            {/* Overlay selector */}
            <div className="flex gap-1 mt-1.5 flex-wrap">
              {KB_OVERLAYS.map((ov) => (
                <button
                  key={ov.id}
                  onClick={() => onChange({ kbConfig: { ...scene.kbConfig, overlay: ov.id } })}
                  disabled={scene.status === "generating" || scene.status === "done"}
                  className={`px-1.5 py-1 text-[8px] rounded-md transition-all ${
                    scene.kbConfig.overlay === ov.id
                      ? "bg-cyan-600 text-white ring-1 ring-cyan-400"
                      : "bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-white"
                  } disabled:opacity-50`}
                  title={ov.label}
                >
                  {ov.emoji} {ov.label}
                </button>
              ))}
            </div>

            {/* Saved presets (user's custom) */}
            {savedKBPresets.length > 0 && (
              <div className="mt-1.5 mb-1">
                <div className="text-[8px] text-amber-400 mb-1">💾 Mis presets:</div>
                <div className="flex flex-wrap gap-1">
                  {savedKBPresets.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => onChange({ kbConfig: { ...p.config } })}
                      className={`group px-2 py-1 text-[9px] rounded-md transition-all relative ${
                        scene.kbConfig.preset === p.name
                          ? "bg-amber-600 text-white ring-1 ring-amber-400"
                          : "bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:bg-[var(--surface-3)] hover:text-white"
                      }`}
                      title={`Zoom ${p.config.start_zoom}→${p.config.end_zoom}%`}
                    >
                      {p.name}
                      <span
                        onClick={(e) => { e.stopPropagation(); onDeleteKBPreset(p.name) }}
                        className="hidden group-hover:inline ml-1 text-red-400 hover:text-red-300 cursor-pointer"
                      >✕</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Built-in preset buttons */}
            <div className="grid grid-cols-4 gap-1 mt-1.5">
              {KB_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onChange({ kbConfig: { ...p.config, preset: p.id } })}
                  disabled={scene.status === "generating" || scene.status === "done"}
                  className={`px-1 py-1.5 text-[9px] rounded-md transition-all ${
                    scene.kbConfig.preset === p.id
                      ? "bg-emerald-600 text-white ring-1 ring-emerald-400"
                      : "bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:bg-[var(--surface-3)] hover:text-white"
                  } disabled:opacity-50`}
                  title={p.label}
                >
                  {p.emoji}
                </button>
              ))}
            </div>
            {/* Manual sliders */}
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[8px] text-[var(--text-tertiary)] w-14">Zoom Ini</span>
                <input type="range" min={100} max={150} value={scene.kbConfig.start_zoom}
                  onChange={(e) => onChange({ kbConfig: { ...scene.kbConfig, preset: null, start_zoom: +e.target.value } })}
                  disabled={scene.status === "generating" || scene.status === "done"}
                  className="flex-1 h-1 accent-emerald-500" />
                <span className="text-[9px] text-white w-8 text-right">{scene.kbConfig.start_zoom}%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[8px] text-[var(--text-tertiary)] w-14">Zoom Fin</span>
                <input type="range" min={100} max={150} value={scene.kbConfig.end_zoom}
                  onChange={(e) => onChange({ kbConfig: { ...scene.kbConfig, preset: null, end_zoom: +e.target.value } })}
                  disabled={scene.status === "generating" || scene.status === "done"}
                  className="flex-1 h-1 accent-emerald-500" />
                <span className="text-[9px] text-white w-8 text-right">{scene.kbConfig.end_zoom}%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[8px] text-[var(--text-tertiary)] w-14">Pos X</span>
                <input type="range" min={0} max={100} value={scene.kbConfig.start_x}
                  onChange={(e) => onChange({ kbConfig: { ...scene.kbConfig, preset: null, start_x: +e.target.value } })}
                  disabled={scene.status === "generating" || scene.status === "done"}
                  className="flex-1 h-1 accent-blue-500" />
                <span className="text-[8px] text-[var(--text-tertiary)]">→</span>
                <input type="range" min={0} max={100} value={scene.kbConfig.end_x}
                  onChange={(e) => onChange({ kbConfig: { ...scene.kbConfig, preset: null, end_x: +e.target.value } })}
                  disabled={scene.status === "generating" || scene.status === "done"}
                  className="flex-1 h-1 accent-blue-500" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[8px] text-[var(--text-tertiary)] w-14">Pos Y</span>
                <input type="range" min={0} max={100} value={scene.kbConfig.start_y}
                  onChange={(e) => onChange({ kbConfig: { ...scene.kbConfig, preset: null, start_y: +e.target.value } })}
                  disabled={scene.status === "generating" || scene.status === "done"}
                  className="flex-1 h-1 accent-blue-500" />
                <span className="text-[8px] text-[var(--text-tertiary)]">→</span>
                <input type="range" min={0} max={100} value={scene.kbConfig.end_y}
                  onChange={(e) => onChange({ kbConfig: { ...scene.kbConfig, preset: null, end_y: +e.target.value } })}
                  disabled={scene.status === "generating" || scene.status === "done"}
                  className="flex-1 h-1 accent-blue-500" />
              </div>
            </div>

            {/* Save & Apply buttons */}
            <div className="flex gap-1.5 mt-2">
              <button
                onClick={() => {
                  const name = prompt("Nombre del preset:")
                  if (name && name.trim()) onSaveKBPreset(name.trim(), scene.kbConfig)
                }}
                disabled={scene.status === "generating" || scene.status === "done"}
                className="flex-1 px-2 py-1.5 text-[9px] font-medium text-amber-300 bg-amber-600/20 hover:bg-amber-600/40 border border-amber-600/40 rounded-md transition-colors disabled:opacity-50"
              >
                💾 Guardar preset
              </button>
              <button
                onClick={() => onApplyKBToAll(scene.kbConfig)}
                disabled={scene.status === "generating" || scene.status === "done"}
                className="flex-1 px-2 py-1.5 text-[9px] font-medium text-emerald-300 bg-emerald-600/20 hover:bg-emerald-600/40 border border-emerald-600/40 rounded-md transition-colors disabled:opacity-50"
              >
                📋 Aplicar a todos
              </button>
            </div>
          </div>
        ) : (
          /* ── Regular Motion Prompt ── */
          <div>
            <label className="text-[9px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
              Motion Prompt {hasPrompt ? "✅" : ""}
            </label>
            <textarea
              value={scene.motionPrompt}
              onChange={(e) => onChange({ motionPrompt: e.target.value })}
              placeholder={isVeo ? "Gemini escribirá el prompt..." : "Gemini escribirá el prompt al auto-preparar..."}
              rows={2}
              disabled={scene.status === "generating" || scene.status === "done"}
              className="w-full mt-1 px-2 py-1.5 text-[11px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded-lg text-white placeholder:text-[var(--text-tertiary)] resize-none focus:border-indigo-500/50 focus:outline-none disabled:opacity-50"
            />
          </div>
        )}
      </div>

      {/* Controls: Model + Resolution (NO duration — it's fixed) */}
      <div className="px-3 pb-2 flex gap-1.5">
        <select
          value={scene.model}
          onChange={(e) => onChange({ model: e.target.value })}
          disabled={scene.status === "generating" || scene.status === "done"}
          className="flex-1 px-1.5 py-1 text-[10px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded text-white disabled:opacity-50"
        >
          {MODELS.map((m) => {
            const isCompatible = m.id === "ken-burns" || m.durations.includes(scene.duration)
            return (
              <option key={m.id} value={m.id}>
                {m.emoji} {m.name} ({m.tier}){!isCompatible ? " ⚠️" : ""}
              </option>
            )
          })}
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

      {/* Volume Control */}
      <div className="px-3 pb-1 flex items-center gap-2">
        <span className="text-[8px] text-[var(--text-tertiary)] w-6">🔊</span>
        <input
          type="range"
          min={0}
          max={200}
          value={scene.volume}
          onChange={(e) => onChange({ volume: Number(e.target.value) })}
          className="flex-1 h-1 accent-emerald-500"
          title={`Volumen: ${scene.volume}%`}
        />
        <span className="text-[8px] text-[var(--text-tertiary)] w-8 text-right">{scene.volume}%</span>
      </div>

      {/* Bottom: Cost + Generate/Cancel */}
      <div className="px-3 pb-3 flex items-center justify-between">
        <span className={`text-xs font-bold ${cost === 0 ? "text-green-400" : cost < 1 ? "text-blue-400" : "text-amber-400"}`}>
          ${cost.toFixed(3)}
        </span>

        {scene.status === "pending" || scene.status === "ready" || scene.status === "error" ? (
          <button
            onClick={onGenerate}
            className="px-3 py-1 text-[10px] font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
          >
            ▶ Generar
          </button>
        ) : scene.status === "done" ? (
          <span className="text-[10px] text-green-400 font-medium">✅ Listo</span>
        ) : (
          <button
            onClick={onCancel}
            className="px-2 py-1 text-[9px] font-medium text-red-400 border border-red-800 hover:bg-red-900/30 rounded-lg transition-colors"
          >
            ✕ Cancelar
          </button>
        )}
      </div>
    </div>
  )
}

/* ── Main Production Panel (Fullscreen) ── */
export const ProductionPanel = memo(function ProductionPanel({
  isOpen,
  onClose,
  chapterData,
  chapterId,
  onVideoGenerated,
}: ProductionPanelProps) {
  const [scenes, setScenes] = useState<SceneState[]>([])
  const [globalModel, setGlobalModel] = useState("ken-burns")
  const [globalResolution, setGlobalResolution] = useState<Resolution>("720p")
  const [activeTier, setActiveTier] = useState<TierName | "manual" | null>(null)
  const [isAutoPreparing, setIsAutoPreparing] = useState(false)
  const [isBatchGenerating, setIsBatchGenerating] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [exportUrl, setExportUrl] = useState<string | null>(null)
  const [isBrowserExportOpen, setIsBrowserExportOpen] = useState(false)
  const [statusMsg, setStatusMsg] = useState("")
  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const mountedRef = useRef(true)

  // ── Saved Ken Burns Presets (localStorage) ──
  const KB_STORAGE_KEY = "zentrix_kb_presets"
  const [savedKBPresets, setSavedKBPresets] = useState<{ name: string; config: KBConfig }[]>(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(KB_STORAGE_KEY) : null
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  })

  const saveKBPreset = useCallback((name: string, config: KBConfig) => {
    setSavedKBPresets((prev) => {
      const updated = [...prev.filter((p) => p.name !== name), { name, config: { ...config, preset: name } }]
      localStorage.setItem(KB_STORAGE_KEY, JSON.stringify(updated))
      setStatusMsg(`💾 Preset "${name}" guardado`)
      return updated
    })
  }, [])

  const deleteKBPreset = useCallback((name: string) => {
    setSavedKBPresets((prev) => {
      const updated = prev.filter((p) => p.name !== name)
      localStorage.setItem(KB_STORAGE_KEY, JSON.stringify(updated))
      setStatusMsg(`🗑 Preset "${name}" eliminado`)
      return updated
    })
  }, [])

  const applyKBToAll = useCallback((config: KBConfig) => {
    let count = 0
    setScenes((prev) =>
      prev.map((s) => {
        if (s.model !== "ken-burns" || s.status === "done" || s.status === "generating") return s
        count++
        return { ...s, kbConfig: { ...config } }
      })
    )
    const label = config.preset || "manual"
    setStatusMsg(`🎞 Ken Burns "${label}" aplicado a ${count} escenas`)
  }, [])

  // ── Scene State Persistence (localStorage per chapter) ──
  const SCENE_STORAGE_KEY = chapterId ? `zentrix_prod_scenes_${chapterId}` : ""

  const saveScenesToStorage = useCallback((scenesToSave: SceneState[]) => {
    if (!SCENE_STORAGE_KEY) return
    try {
      const toSave = scenesToSave.map((s) => ({
        index: s.index, model: s.model, resolution: s.resolution,
        motionPrompt: s.motionPrompt, classification: s.classification,
        kbConfig: s.kbConfig, status: s.status, videoUrl: s.videoUrl,
        volume: s.volume, jobId: s.jobId,
      }))
      localStorage.setItem(SCENE_STORAGE_KEY, JSON.stringify(toSave))
    } catch {}
  }, [SCENE_STORAGE_KEY])

  // Initialize scenes — duration FIXED from timeline + restore saved state
  useEffect(() => {
    if (!chapterData) return

    // Load saved state from localStorage
    let savedMap: Record<number, any> = {}
    try {
      const raw = SCENE_STORAGE_KEY ? localStorage.getItem(SCENE_STORAGE_KEY) : null
      if (raw) {
        const arr = JSON.parse(raw)
        savedMap = Object.fromEntries(arr.map((s: any) => [s.index, s]))
      }
    } catch {}

    const initial: SceneState[] = chapterData.scenes
      .filter((s) => s.image_url || s.video_url)
      .map((s) => {
        const rawDuration = (s.end_time !== null && s.start_time !== null)
          ? Math.round(s.end_time - s.start_time)
          : 8
        const duration = snapToStandardDuration(rawDuration)
        const compatible = getCompatibleModels(duration)
        const defaultModel = compatible.find((m) => m.id === "pruna-video-draft") ? "pruna-video-draft" : compatible.find((m) => m.id === "ken-burns") ? "ken-burns" : compatible[0]?.id || "ken-burns"

        // Restore saved config if available
        const saved = savedMap[s.index]

        // Determine model: if saved as ken-burns but no KB video exists, switch to PrunaAI Draft
        let model = saved?.model || (s.video_url ? (s.video_model || defaultModel) : defaultModel)
        if (model === "ken-burns" && !s.video_url && !(saved?.status === "done" && saved?.videoUrl)) {
          model = defaultModel // pruna-video-draft
        }

        return {
          index: s.index,
          model,
          duration,
          resolution: (saved?.resolution || "720p") as Resolution,
          motionPrompt: saved?.motionPrompt || "",
          classification: saved?.classification || "",
          kbConfig: saved?.kbConfig || { ...KB_DEFAULT },
          status: s.video_url ? "done" as const : (saved?.status === "done" && saved?.videoUrl) ? "done" as const : "pending" as const,
          videoUrl: s.video_url || saved?.videoUrl || null,
          errorMsg: "",
          volume: saved?.volume ?? 100,
          jobId: saved?.jobId || null,
        }
      })
    setScenes(initial)

    // Fetch video-progress to detect completed videos not in chapterData
    if (chapterId) {
      apiFetch(`/api/image-studio/chapters/${chapterId}/video-progress`).then((data) => {
        if (!data.videos || !mountedRef.current) return
        setScenes((prev) => {
          let changed = false
          const updated = prev.map((s) => {
            if (s.status === "done" && s.videoUrl) return s
            const vid = data.videos.find((v: any) => v.segment_index === s.index)
            if (!vid) return s
            const isKB = s.model === "ken-burns"
            const status = isKB ? vid.kb_status : vid.veo_status
            const url = isKB ? vid.kb_url : vid.veo_url
            if (status === "done" && url) {
              changed = true
              onVideoGenerated(s.index, url)
              return { ...s, status: "done" as const, videoUrl: url }
            }
            return s
          })
          if (changed) saveScenesToStorage(updated)
          return changed ? updated : prev
        })
      }).catch(() => {})
    }
  }, [chapterData, chapterId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [])

  // Auto-save scene state to localStorage on every change
  useEffect(() => {
    if (scenes.length > 0) saveScenesToStorage(scenes)
  }, [scenes, saveScenesToStorage])

  // Apply global model + resolution to compatible scenes only
  const applyGlobalToAll = useCallback(() => {
    setScenes((prev) =>
      prev.map((s) => {
        if (s.status === "done" || s.status === "generating") return s
        // Only apply if the global model supports this scene's duration
        const compatible = getCompatibleModels(s.duration)
        const canUseGlobal = compatible.some((m) => m.id === globalModel)
        return {
          ...s,
          model: canUseGlobal ? globalModel : s.model,
          resolution: globalResolution,
        }
      })
    )
    // Tell user how many were updated
    const total = scenes.filter((s) => s.status !== "done" && s.status !== "generating").length
    const compatible = scenes.filter((s) => {
      if (s.status === "done" || s.status === "generating") return false
      return getCompatibleModels(s.duration).some((m) => m.id === globalModel)
    }).length
    if (compatible < total) {
      setStatusMsg(`✅ ${compatible}/${total} escenas actualizadas. ${total - compatible} no son compatibles con ${MODEL_MAP[globalModel]?.name || globalModel} por su duración.`)
    } else {
      setStatusMsg(`✅ ${compatible} escenas actualizadas a ${MODEL_MAP[globalModel]?.name || globalModel} ${globalResolution}`)
    }
  }, [globalModel, globalResolution, scenes])

  // Apply tier preset — auto-assigns best model per scene duration
  const applyTier = useCallback((tier: TierName) => {
    const config = TIER_CONFIG[tier]
    let updated = 0
    setScenes((prev) =>
      prev.map((s) => {
        if (s.status === "done" || s.status === "generating") return s
        const modelId = config.mapping[s.duration]
        if (!modelId) return s
        // Verify the model actually supports this duration
        const model = MODEL_MAP[modelId]
        if (!model || !model.durations.includes(s.duration)) return s
        updated++
        return { ...s, model: modelId, resolution: globalResolution }
      })
    )
    setActiveTier(tier)
    const tierLabel = config.emoji + " " + config.label
    const totalScenes = scenes.filter((s) => s.status !== "done" && s.status !== "generating").length
    setStatusMsg(`${tierLabel}: ${updated}/${totalScenes} escenas asignadas automáticamente`)
  }, [globalResolution, scenes])

  const updateScene = useCallback((index: number, updates: Partial<SceneState>) => {
    setScenes((prev) =>
      prev.map((s) => (s.index === index ? { ...s, ...updates } : s))
    )
  }, [])

  /* ── Auto-preparar: Gemini writes motion prompts ── */
  const handleAutoPrepare = useCallback(async () => {
    if (!chapterId) return
    setIsAutoPreparing(true)
    setStatusMsg("🤖 Analizando cada imagen y escribiendo motion prompts...")

    try {
      const result = await apiFetch(
        `/api/image-studio/chapters/${chapterId}/auto-prepare-videos`,
        {
          method: "POST",
          body: JSON.stringify({
            default_duration: 10,
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
              motionPrompt: prepared.motion_prompt || s.motionPrompt,
              classification: prepared.classification || "",
              status: "ready" as const,
              // Keep model and duration as-is — user already chose them
            }
          })
        )
        setStatusMsg(`✅ ${result.scenes.length} motion prompts escritos. Revisa y genera.`)
      } else {
        setStatusMsg("⚠️ Respuesta inesperada del servidor")
      }
    } catch (e: unknown) {
      if (!mountedRef.current) return
      setStatusMsg(`❌ Error: ${e instanceof Error ? e.message : "Error desconocido"}`)
    } finally {
      if (mountedRef.current) setIsAutoPreparing(false)
    }
  }, [chapterId, globalResolution])

  /* ── Delete video from scene ── */
  const deleteSceneVideo = useCallback(async (sceneIndex: number) => {
    if (!chapterId) return
    try {
      await apiFetch(`/api/image-studio/chapters/${chapterId}/video/${sceneIndex}`, {
        method: "DELETE",
      })
      setStatusMsg(`🗑 Video de escena ${sceneIndex + 1} eliminado`)
    } catch {
      // Backend says no video — that's fine, clean up UI anyway
      setStatusMsg(`🗑 Escena ${sceneIndex + 1} reseteada`)
    }
    // ALWAYS reset the scene regardless of backend response
    updateScene(sceneIndex, { status: "pending", videoUrl: null, errorMsg: "" })
  }, [chapterId, updateScene])

  const cancelSceneVideo = useCallback(async (sceneIndex: number) => {
    const scene = scenes.find((s) => s.index === sceneIndex)
    if (!chapterId || !scene?.jobId) {
      updateScene(sceneIndex, { status: "pending", errorMsg: "" })
      return
    }
    try {
      const result = await apiFetch(`/api/image-studio/chapters/${chapterId}/cancel-job/${scene.jobId}`, {
        method: "POST",
      })
      updateScene(sceneIndex, { status: "pending", jobId: null, errorMsg: "" })
      setStatusMsg(result.credits_saved ? `✅ Escena ${sceneIndex + 1} cancelada — créditos ahorrados` : `⚠️ Escena ${sceneIndex + 1} cancelada — crédito ya consumido`)
    } catch {
      updateScene(sceneIndex, { status: "pending", jobId: null, errorMsg: "" })
      setStatusMsg(`✕ Escena ${sceneIndex + 1} cancelada localmente`)
    }
  }, [chapterId, scenes, updateScene])

  const cancelAllQueued = useCallback(async () => {
    if (!chapterId) return
    try {
      const result = await apiFetch(`/api/image-studio/chapters/${chapterId}/cancel-all-queued`, { method: "POST" })
      setScenes((prev) => prev.map((s) =>
        s.status === "generating" ? { ...s, status: "pending" as const, jobId: null, errorMsg: "" } : s
      ))
      setStatusMsg(`✕ ${result.cancelled} jobs cancelados`)
    } catch {
      setStatusMsg("❌ Error al cancelar")
    }
  }, [chapterId])

  /* ── Generate single scene ── */
  const generateScene = useCallback(async (sceneIndex: number) => {
    if (!chapterId) return
    const scene = scenes.find((s) => s.index === sceneIndex)
    if (!scene) return

    updateScene(sceneIndex, { status: "generating", errorMsg: "" })

    try {
      let motionPromptToSend = scene.model === "ken-burns"
        ? JSON.stringify(scene.kbConfig)
        : scene.motionPrompt

      // Auto-generate motion prompt if empty (for non-Ken Burns models)
      if (!motionPromptToSend?.trim() && scene.model !== "ken-burns") {
        setStatusMsg(`🤖 Generando prompt para escena ${sceneIndex + 1}...`)
        const promptResult = await apiFetch(
          `/api/image-studio/chapters/${chapterId}/improve-motion-prompt`,
          {
            method: "POST",
            body: JSON.stringify({
              segment_index: sceneIndex,
              video_model: scene.model,
              motion_prompt: "",
              audio_prompt: "",
            }),
          }
        )
        motionPromptToSend = promptResult.motion_prompt || ""
        // Update scene with the generated prompt
        updateScene(sceneIndex, { 
          motionPrompt: motionPromptToSend,
          status: "generating" as const,
        })
      }

      await apiFetch(`/api/image-studio/chapters/${chapterId}/animate-scene`, {
        method: "POST",
        body: JSON.stringify({
          segment_index: sceneIndex,
          video_model: scene.model,
          duration_seconds: scene.duration,
          resolution: scene.resolution,
          motion_prompt: motionPromptToSend,
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
      (s) => (s.status === "pending" || s.status === "ready" || s.status === "error") && s.model !== ""
    )
    if (pendingScenes.length === 0) {
      setStatusMsg("⚠️ No hay escenas pendientes de generar.")
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
        let motionPromptToSend = scene.model === "ken-burns"
          ? JSON.stringify(scene.kbConfig)
          : scene.motionPrompt

        // Auto-generate motion prompt if empty
        if (!motionPromptToSend?.trim() && scene.model !== "ken-burns") {
          if (mountedRef.current) setStatusMsg(`🤖 Prompt escena ${scene.index + 1}... (${sent}/${pendingScenes.length})`)
          const promptResult = await apiFetch(
            `/api/image-studio/chapters/${chapterId}/improve-motion-prompt`,
            {
              method: "POST",
              body: JSON.stringify({
                segment_index: scene.index,
                video_model: scene.model,
                motion_prompt: "",
                audio_prompt: "",
              }),
            }
          )
          motionPromptToSend = promptResult.motion_prompt || ""
          updateScene(scene.index, { motionPrompt: motionPromptToSend })
        }

        await apiFetch(`/api/image-studio/chapters/${chapterId}/animate-scene`, {
          method: "POST",
          body: JSON.stringify({
            segment_index: scene.index,
            video_model: scene.model,
            duration_seconds: scene.duration,
            resolution: scene.resolution,
            motion_prompt: motionPromptToSend,
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

  /* ── Export Chapter ── */
  const handleExport = useCallback(async () => {
    if (!chapterId || isExporting) return
    setIsExporting(true)
    setExportUrl(null)
    setStatusMsg("📦 Iniciando exportación del capítulo completo...")

    try {
      const result = await apiFetch(`/api/image-studio/chapters/${chapterId}/export-chapter`, {
        method: "POST",
        body: JSON.stringify({ include_audio: true }),
      })
      const jobId = result.export_job_id
      setStatusMsg("📦 Exportando... El worker está concatenando todos los clips + audio.")

      // Poll export status
      const pollExport = setInterval(async () => {
        try {
          const status = await apiFetch(`/api/image-studio/chapters/${chapterId}/export-status/${jobId}`)
          if (status.status === "done" && status.download_url) {
            clearInterval(pollExport)
            setExportUrl(status.download_url)
            setIsExporting(false)
            setStatusMsg("✅ ¡Exportación completa! Click en 'Descargar' para obtener el video.")
          } else if (status.status === "error") {
            clearInterval(pollExport)
            setIsExporting(false)
            setStatusMsg(`❌ Error de exportación: ${status.error || "Error desconocido"}`)
          } else {
            setStatusMsg(`📦 Exportando... (${status.status})`)
          }
        } catch {
          // Silent poll error
        }
      }, 10000) // Poll every 10 seconds

    } catch (e: unknown) {
      setIsExporting(false)
      setStatusMsg(`❌ Error: ${e instanceof Error ? e.message : "Error"}`)
    }
  }, [chapterId, isExporting])

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
        <div>
          <h1 className="text-sm font-bold text-white">
            🎬 Producción — {chapterData.project_name}
          </h1>
          <p className="text-[10px] text-[var(--text-tertiary)]">
            Cap {chapterData.chapter_number}: {chapterData.chapter_title} — {scenes.length} escenas
          </p>
        </div>

        {/* Global: Tiers + Manual + Resolution */}
        <div className="flex items-center gap-2">
          {/* Tier Buttons */}
          {(Object.entries(TIER_CONFIG) as [TierName, typeof TIER_CONFIG[TierName]][]).map(([key, cfg]) => (
            <button
              key={key}
              onClick={() => applyTier(key)}
              className={`px-3 py-1.5 text-[10px] font-medium text-white rounded-lg transition-all ${
                activeTier === key
                  ? cfg.color + " ring-1 ring-white/40"
                  : "bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border-default)]"
              }`}
              title={cfg.description}
            >
              {cfg.emoji} {cfg.label}
            </button>
          ))}

          {/* Separator */}
          <div className="w-px h-6 bg-[var(--border-default)] mx-1" />

          {/* Manual model selector */}
          <div className="flex flex-col">
            <label className="text-[8px] text-[var(--text-tertiary)] uppercase mb-0.5">Manual</label>
            <select
              value={globalModel}
              onChange={(e) => { setGlobalModel(e.target.value); setActiveTier("manual") }}
              className="px-2 py-1 text-[10px] bg-[var(--surface-2)] border border-[var(--border-default)] rounded text-white"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.emoji} {m.name} ({m.tier})</option>
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
            title="Aplica el modelo Manual seleccionado a escenas compatibles"
          >
            Aplicar Manual
          </button>

          <button
            onClick={onClose}
            className="ml-2 px-3 py-1.5 text-[10px] font-medium text-[var(--text-tertiary)] hover:text-white border border-[var(--border-default)] hover:border-red-500 rounded-lg transition-colors mt-2.5"
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
          {activeTier && activeTier !== "manual" && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--surface-2)] border border-[var(--border-default)]">
              {TIER_CONFIG[activeTier].emoji} {TIER_CONFIG[activeTier].label}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              if (!chapterId) return
              setStatusMsg("🔄 Actualizando...")
              try {
                const data = await apiFetch(`/api/image-studio/chapters/${chapterId}/video-progress`)
                if (!data.videos) return
                let updated = 0
                setScenes((prev) =>
                  prev.map((s) => {
                    const vid = data.videos.find((v: any) => v.segment_index === s.index)

                    // If backend has no record AND scene claims to be done → reset to pending
                    if (!vid) {
                      if (s.status === "done" && s.videoUrl) {
                        updated++
                        return { ...s, status: "pending" as const, videoUrl: null, errorMsg: "" }
                      }
                      return s
                    }

                    // Determine best URL: prefer AI model over ken-burns
                    const veoUrl = vid.veo_url
                    const kbUrl = vid.kb_url
                    const veoStatus = vid.veo_status
                    const kbStatus = vid.kb_status
                    const isKB = s.model === "ken-burns"
                    const relevantStatus = isKB ? kbStatus : (veoStatus !== "none" ? veoStatus : kbStatus)
                    const relevantUrl = isKB ? kbUrl : (veoUrl || kbUrl)

                    // Backend says no video exists for this scene → reset
                    if (relevantStatus === "none" && s.status === "done") {
                      updated++
                      return { ...s, status: "pending" as const, videoUrl: null, errorMsg: "" }
                    }

                    // Update if: new video found, or status changed, or URL refreshed
                    if (relevantStatus === "done" && relevantUrl) {
                      if (s.status !== "done" || s.videoUrl !== relevantUrl) {
                        updated++
                        onVideoGenerated(s.index, relevantUrl)
                        return { ...s, status: "done" as const, videoUrl: relevantUrl, errorMsg: "" }
                      }
                    } else if (relevantStatus === "error" && s.status !== "error") {
                      updated++
                      return { ...s, status: "error" as const, errorMsg: vid.veo_error || "Error de generación" }
                    } else if ((relevantStatus === "queued" || relevantStatus === "processing" || relevantStatus === "polling") && s.status !== "generating") {
                      return { ...s, status: "generating" as const }
                    }
                    return s
                  })
                )
                setStatusMsg(updated > 0 ? `🔄 ${updated} escenas actualizadas` : "✅ Todo al día — sin cambios")
              } catch { setStatusMsg("❌ Error al actualizar") }
            }}
            className="px-3 py-2 text-xs font-medium text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg transition-colors flex items-center gap-1"
          >
            🔄 Actualizar
          </button>

          <button
            onClick={handleAutoPrepare}
            disabled={isAutoPreparing || isBatchGenerating}
            className="px-4 py-2 text-xs font-medium text-white bg-purple-600 hover:bg-purple-500 rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            {isAutoPreparing ? (
              <><span className="animate-spin">🤖</span> Escribiendo prompts...</>
            ) : (
              <>🤖 Auto-preparar prompts</>
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

          {generatingCount > 0 && (
            <button
              onClick={cancelAllQueued}
              className="px-3 py-2 text-xs font-medium text-red-400 border border-red-800 hover:bg-red-900/30 rounded-lg transition-colors flex items-center gap-1"
            >
              ✕ Cancelar Todo ({generatingCount})
            </button>
          )}

          <button
            onClick={() => setIsBrowserExportOpen(true)}
            disabled={doneCount === 0}
            title="Exporta el video en tu computadora usando FFmpeg.wasm — sin usar el servidor"
            className="px-4 py-2 text-xs font-medium text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            💻 Exportar en mi PC
          </button>

          <button
            onClick={handleExport}
            disabled={isExporting || doneCount === 0}
            title="Combina todos los videos + audio en el servidor (fallback)"
            className="px-4 py-2 text-xs font-medium text-white bg-green-600 hover:bg-green-500 rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            {isExporting ? (
              <><span className="animate-spin">📦</span> Exportando...</>
            ) : (
              <>📦 Servidor (fallback)</>
            )}
          </button>

          {exportUrl && (
            <a
              href={exportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-400 rounded-lg transition-colors flex items-center gap-2 animate-pulse"
            >
              ⬇️ Descargar Video
            </a>
          )}
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
                savedKBPresets={savedKBPresets}
                onSaveKBPreset={saveKBPreset}
                onDeleteKBPreset={deleteKBPreset}
                onApplyKBToAll={applyKBToAll}
                onChange={(updates) => updateScene(scene.index, updates)}
                onGenerate={() => generateScene(scene.index)}
                onCancel={() => cancelSceneVideo(scene.index)}
                onDelete={() => deleteSceneVideo(scene.index)}
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

      {/* Browser Export Dialog */}
      <BrowserExportDialog
        isOpen={isBrowserExportOpen}
        onClose={() => setIsBrowserExportOpen(false)}
        scenes={scenes
          .filter((s) => s.status === "done" && s.videoUrl)
          .sort((a, b) => a.index - b.index)
          .map((s) => ({
            index: s.index,
            videoUrl: s.videoUrl!,
            volume: s.volume,
            duration: s.duration,
          }))}
        projectName={chapterData.project_name || "Zentrix"}
        chapterTitle={chapterData.chapter_title || ""}
        chapterNumber={chapterData.chapter_number || 1}
      />
    </div>
  )
})

export default ProductionPanel
