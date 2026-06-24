"use client"

import { useState, useEffect, useCallback, memo } from "react"
import type { MediaItem } from "../types"
import { PanelLeftClose } from "./icons"

const BACKEND_URL =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:8000"
    : "https://zentrix-backend-mcvk.onrender.com"

const TOKEN_KEY = "zentrix_token"

async function apiFetch(path: string, token: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(BACKEND_URL + path, { ...opts, headers })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || "Error del servidor")
  return data
}

interface ZentrixProject {
  id: number
  name: string
  [key: string]: unknown
}

interface ZentrixChapter {
  id: number
  title: string
  chapter_number: number
  [key: string]: unknown
}

interface ZentrixScene {
  index: number
  start_time: number
  end_time: number
  text_excerpt: string
  image_prompt: string
  image_url: string | null
  video_url: string | null
  video_model: string | null
}

interface EditorData {
  project_name: string
  chapter_title: string
  chapter_number: number
  audio_url: string | null
  audio_duration: number | null
  total_scenes: number
  scenes: ZentrixScene[]
}

interface ZentrixPanelProps {
  onClose: () => void
  onLoadMedia: (items: MediaItem[]) => void
}

/* ── Login Form ── */
function LoginForm({ onLogin, error }: { onLogin: (email: string, pass: string) => void; error: string }) {
  const [email, setEmail] = useState("")
  const [pass, setPass] = useState("")
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    setLoading(true)
    await onLogin(email, pass)
    setLoading(false)
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="text-center mb-2">
        <div className="text-2xl mb-1">🎬</div>
        <div className="text-sm font-semibold text-white">Zentrix Image Studio</div>
        <div className="text-[10px] text-[var(--text-tertiary)] mt-1">Conectar con tu cuenta</div>
      </div>
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full px-3 py-2 text-sm bg-[var(--surface-2)] border border-[var(--border-default)] rounded-lg text-white placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] transition-colors"
      />
      <input
        type="password"
        placeholder="Contraseña"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        className="w-full px-3 py-2 text-sm bg-[var(--surface-2)] border border-[var(--border-default)] rounded-lg text-white placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] transition-colors"
      />
      {error && <div className="text-xs text-red-400">{error}</div>}
      <button
        onClick={submit}
        disabled={loading || !email || !pass}
        className="w-full py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
      >
        {loading ? "Conectando..." : "Entrar"}
      </button>
    </div>
  )
}

/* ── Project/Chapter Selector ── */
function ChapterSelector({
  token,
  onLoad,
  onLogout,
}: {
  token: string
  onLoad: (data: EditorData) => void
  onLogout: () => void
}) {
  const [projects, setProjects] = useState<ZentrixProject[]>([])
  const [chapters, setChapters] = useState<ZentrixChapter[]>([])
  const [selProject, setSelProject] = useState("")
  const [selChapter, setSelChapter] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadingChapters, setLoadingChapters] = useState(false)
  const [error, setError] = useState("")

  // Load projects
  useEffect(() => {
    apiFetch("/api/image-studio/projects", token)
      .then((d) => setProjects(Array.isArray(d) ? d : d.projects || []))
      .catch((e) => setError(e.message))
  }, [token])

  // Load chapters when project selected
  useEffect(() => {
    if (!selProject) { setChapters([]); setSelChapter(""); return }
    setLoadingChapters(true)
    setSelChapter("")
    apiFetch(`/api/image-studio/projects/${selProject}`, token)
      .then((d) => setChapters(d.chapters || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoadingChapters(false))
  }, [selProject, token])

  // Load chapter into editor
  const handleLoad = async () => {
    if (!selChapter) return
    setLoading(true)
    setError("")
    try {
      const data = await apiFetch(`/api/image-studio/chapters/${selChapter}/editor-data`, token)
      onLoad(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al cargar")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-white">📂 Image Studio</div>
        <button
          onClick={onLogout}
          className="text-[10px] text-[var(--text-tertiary)] hover:text-red-400 transition-colors"
        >
          Cerrar sesión
        </button>
      </div>

      {/* Project selector */}
      <div>
        <label className="text-[10px] font-medium text-[var(--text-tertiary)] mb-1 block">Proyecto</label>
        <select
          value={selProject}
          onChange={(e) => setSelProject(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-[var(--surface-2)] border border-[var(--border-default)] rounded-lg text-white"
        >
          <option value="">— Seleccionar proyecto —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Chapter selector */}
      {selProject && (
        <div>
          <label className="text-[10px] font-medium text-[var(--text-tertiary)] mb-1 block">Capítulo</label>
          {loadingChapters ? (
            <div className="text-xs text-[var(--text-tertiary)] py-2">Cargando capítulos...</div>
          ) : (
            <select
              value={selChapter}
              onChange={(e) => setSelChapter(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-[var(--surface-2)] border border-[var(--border-default)] rounded-lg text-white"
            >
              <option value="">— Seleccionar capítulo —</option>
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  Cap {c.chapter_number}: {c.title}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* Load button */}
      {selChapter && (
        <button
          onClick={handleLoad}
          disabled={loading}
          className="w-full py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <span className="animate-pulse">⏳</span> Cargando escenas...
            </>
          ) : (
            <>🚀 Cargar en Timeline</>
          )}
        </button>
      )}
    </div>
  )
}

/* ── Loaded Chapter Info ── */
function LoadedInfo({
  data,
  onLoadAnother,
}: {
  data: EditorData
  onLoadAnother: () => void
}) {
  const videoCount = data.scenes.filter((s) => s.video_url).length
  const imageCount = data.scenes.filter((s) => s.image_url && !s.video_url).length

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-green-400">✅ Capítulo cargado</div>
      </div>
      <div className="bg-[var(--surface-2)] rounded-lg p-3 space-y-2">
        <div className="text-sm font-medium text-white">{data.project_name}</div>
        <div className="text-xs text-[var(--text-secondary)]">
          Cap {data.chapter_number}: {data.chapter_title}
        </div>
        <div className="flex gap-3 text-[10px] text-[var(--text-tertiary)]">
          <span>{data.total_scenes} escenas</span>
          <span>{videoCount} videos</span>
          <span>{imageCount} imágenes</span>
        </div>
        {data.audio_url && (
          <div className="text-[10px] text-amber-400">
            🎙 Audio: {Math.round(data.audio_duration || 0)}s
          </div>
        )}
      </div>
      <button
        onClick={onLoadAnother}
        className="w-full py-2 text-xs text-[var(--text-secondary)] hover:text-white border border-[var(--border-default)] hover:border-[var(--border-strong)] rounded-lg transition-colors"
      >
        Cargar otro capítulo
      </button>
    </div>
  )
}

/* ── Main Panel ── */
export const ZentrixPanel = memo(function ZentrixPanel({ onClose, onLoadMedia }: ZentrixPanelProps) {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window !== "undefined") return localStorage.getItem(TOKEN_KEY)
    return null
  })
  const [loginError, setLoginError] = useState("")
  const [loadedData, setLoadedData] = useState<EditorData | null>(null)

  const handleLogin = useCallback(async (email: string, pass: string) => {
    setLoginError("")
    try {
      const d = await apiFetch("/api/login", "", {
        method: "POST",
        body: JSON.stringify({ email, password: pass }),
      })
      localStorage.setItem(TOKEN_KEY, d.token)
      setToken(d.token)
    } catch (e: unknown) {
      setLoginError(e instanceof Error ? e.message : "Error de conexión")
    }
  }, [])

  const handleLogout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setLoadedData(null)
  }, [])

  const handleLoad = useCallback(
    (data: EditorData) => {
      setLoadedData(data)

      // Convert scenes to MediaItem[]
      const mediaItems: MediaItem[] = []

      for (const scene of data.scenes) {
        const url = scene.video_url || scene.image_url
        if (!url) continue

        mediaItems.push({
          id: `zentrix-s${scene.index}`,
          url,
          prompt: scene.image_prompt || scene.text_excerpt || `Escena ${scene.index + 1}`,
          duration: (scene.end_time || 0) - (scene.start_time || 0) || 10,
          aspectRatio: "16:9",
          thumbnailUrl: scene.image_url || undefined,
          status: "ready",
          type: scene.video_url ? "video" : "image",
          resolution: { width: 1280, height: 720 },
        })
      }

      // Add audio as a separate media item
      if (data.audio_url) {
        mediaItems.push({
          id: "zentrix-audio",
          url: data.audio_url,
          prompt: `Audio: ${data.chapter_title}`,
          duration: data.audio_duration || 0,
          aspectRatio: "16:9",
          status: "ready",
          type: "audio",
        })
      }

      onLoadMedia(mediaItems)
    },
    [onLoadMedia],
  )

  return (
    <div className="flex h-full w-[320px] flex-col border-r border-[var(--border-default)] bg-[var(--surface-0)]">
      {/* Header */}
      <div className="flex h-10 items-center justify-between border-b border-[var(--border-default)] px-4">
        <span className="text-xs font-semibold text-white">Zentrix</span>
        <button
          onClick={onClose}
          className="text-[var(--text-tertiary)] hover:text-white transition-colors"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {!token ? (
          <LoginForm onLogin={handleLogin} error={loginError} />
        ) : loadedData ? (
          <LoadedInfo data={loadedData} onLoadAnother={() => setLoadedData(null)} />
        ) : (
          <ChapterSelector token={token} onLoad={handleLoad} onLogout={handleLogout} />
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-[var(--border-default)] px-4 py-2">
        <div className="text-[9px] text-[var(--text-tertiary)] text-center">
          {token ? "🟢 Conectado a Image Studio" : "🔴 No conectado"}
        </div>
      </div>
    </div>
  )
})

export default ZentrixPanel
