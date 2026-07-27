"use client"

import { useState, useEffect, useCallback, memo } from "react"
import { PanelLeftClose } from "./icons"

const BACKEND_URL =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:8000"
    : "https://zentrix-backend-mcvk.onrender.com"

const TOKEN_KEY = "zentrix_token"

type ApiError = Error & { status?: number }

async function apiFetch(path: string, token: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(BACKEND_URL + path, { ...opts, headers })
  let data: any = null
  try { data = await res.json() } catch { data = null }
  if (!res.ok) {
    const err = new Error((data && data.detail) || "Error del servidor") as ApiError
    err.status = res.status
    throw err
  }
  return data
}

/* ¿El fallo es de sesión (token caducado/ausente)? El backend responde 401 y el texto
   "Token inválido o expirado". Si es eso, hay que devolver al usuario al login en vez
   de dejarlo atascado mirando el error rojo con el desplegable vacío. */
function isAuthError(e: unknown): boolean {
  if (e && typeof e === "object" && "status" in e && (e as ApiError).status === 401) return true
  const msg = e instanceof Error ? e.message.toLowerCase() : ""
  return msg.includes("token") || msg.includes("autoriz") || msg.includes("sesión") || msg.includes("sesion")
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

export interface ZentrixScene {
  index: number
  start_time: number
  end_time: number
  text_excerpt: string
  image_prompt: string
  image_url: string | null
  video_url: string | null
  video_model: string | null
}

export interface ZentrixEditorData {
  project_name: string
  chapter_title: string
  chapter_number: number
  audio_url: string | null
  audio_duration: number | null
  total_scenes: number
  scenes: ZentrixScene[]
}

export interface TimingEntry {
  index: number
  start_time: number
  end_time: number
  duration: number
}

/* Las dos alas separadas: cada capítulo viene de UNA de ellas. */
export type ZentrixSource = "image-studio" | "storyboard"

export const SOURCE_META: Record<ZentrixSource, { label: string; icon: string; note: string }> = {
  "image-studio": { label: "Image Studio", icon: "🖼", note: "Documental · sin personajes fijos" },
  "storyboard": { label: "Storyboard", icon: "🎭", note: "Serie con elenco · personajes" },
}

export interface ZentrixChapterWithTiming {
  data: ZentrixEditorData
  timing: TimingEntry[] | null
  chapterId: string
  source: ZentrixSource
}

export interface ZentrixPanelProps {
  onClose: () => void
  onLoadChapter: (result: ZentrixChapterWithTiming) => void
  onClearProject: () => void
  onOpenProduction?: () => void
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
  onAuthExpired,
}: {
  token: string
  onLoad: (result: ZentrixChapterWithTiming) => void
  onLogout: () => void
  onAuthExpired: () => void
}) {
  const [source, setSource] = useState<ZentrixSource>("image-studio")
  const [projects, setProjects] = useState<ZentrixProject[]>([])
  const [chapters, setChapters] = useState<ZentrixChapter[]>([])
  const [selProject, setSelProject] = useState("")
  const [selChapter, setSelChapter] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadingChapters, setLoadingChapters] = useState(false)
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")

  // Al cambiar de ala se limpia la selección y se recargan los proyectos de ESA ala.
  useEffect(() => {
    setProjects([]); setChapters([]); setSelProject(""); setSelChapter(""); setError("")
    apiFetch(`/api/${source}/projects`, token)
      .then((d) => setProjects(Array.isArray(d) ? d : d.projects || []))
      .catch((e) => { if (isAuthError(e)) onAuthExpired(); else setError(e.message) })
  }, [token, source, onAuthExpired])

  useEffect(() => {
    if (!selProject) { setChapters([]); setSelChapter(""); return }
    setLoadingChapters(true)
    setSelChapter("")
    apiFetch(`/api/${source}/projects/${selProject}`, token)
      .then((d) => setChapters(d.chapters || []))
      .catch((e) => { if (isAuthError(e)) onAuthExpired(); else setError(e.message) })
      .finally(() => setLoadingChapters(false))
  }, [selProject, token, source, onAuthExpired])

  const handleLoad = async () => {
    if (!selChapter) return
    setLoading(true)
    setError("")
    setStatus("📥 Cargando datos del capítulo...")

    try {
      // Step 1: Get chapter data from the CURRENT ala (image-studio o storyboard)
      const data: ZentrixEditorData = await apiFetch(
        `/api/${source}/chapters/${selChapter}/editor-data`,
        token,
      )

      // Step 2: tiempos. FUENTE DE VERDAD = los start/end del análisis del capítulo
      // (el backend ya los cuadra al segundo con la duración real del audio).
      // El re-análisis de Gemini de aquí queda SOLO como respaldo para capítulos
      // viejos sin tiempos — tener dos análisis compitiendo causaba el desfase
      // video-más-corto-que-el-audio en el timeline.
      let timing: TimingEntry[] | null = null
      const lastSceneEnd = data.scenes.length
        ? Math.max(...data.scenes.map((s) => s.end_time || 0))
        : 0
      const hasBackendTiming = lastSceneEnd > 1

      if (hasBackendTiming) {
        setStatus("✅ Usando los tiempos del análisis del capítulo...")
      } else if (data.audio_url && data.scenes.length > 0) {
        setStatus("🎵 Gemini está analizando el audio...")
        try {
          const analyzeRes = await fetch("/api/seq/analyze-audio", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              audio_url: data.audio_url,
              audio_duration: data.audio_duration,
              scenes: data.scenes.map((s) => ({
                index: s.index,
                text_excerpt: s.text_excerpt,
                image_prompt: s.image_prompt,
              })),
            }),
          })

          if (analyzeRes.ok) {
            const analyzeData = await analyzeRes.json()
            timing = analyzeData.timing
            setStatus("✅ Audio analizado — colocando escenas...")
          } else {
            const err = await analyzeRes.json()
            console.warn("Gemini analysis failed, using fallback:", err)
            setStatus("⚠️ Gemini no disponible — usando tiempos calculados...")
          }
        } catch (e) {
          console.warn("Gemini analysis error:", e)
          setStatus("⚠️ Error de análisis — usando tiempos calculados...")
        }
      }

      onLoad({ data, timing, chapterId: selChapter, source })
    } catch (e: unknown) {
      if (isAuthError(e)) onAuthExpired()
      else setError(e instanceof Error ? e.message : "Error al cargar")
    } finally {
      setLoading(false)
      setStatus("")
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-white">📂 Cargar capítulo</div>
        <button
          onClick={onLogout}
          className="text-[10px] text-[var(--text-tertiary)] hover:text-red-400 transition-colors"
        >
          Cerrar sesión
        </button>
      </div>

      {/* Selector de ALA — cada una es independiente */}
      <div className="grid grid-cols-2 gap-1.5 p-1 bg-[var(--surface-2)] rounded-lg">
        {(Object.keys(SOURCE_META) as ZentrixSource[]).map((s) => {
          const meta = SOURCE_META[s]
          const active = source === s
          return (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`flex flex-col items-center gap-0.5 rounded-md px-2 py-2 transition-colors ${
                active ? "bg-indigo-600 text-white" : "text-[var(--text-tertiary)] hover:text-white"
              }`}
            >
              <span className="text-sm">{meta.icon} <span className="text-xs font-medium">{meta.label}</span></span>
              <span className="text-[9px] opacity-80 leading-tight text-center">{meta.note}</span>
            </button>
          )
        })}
      </div>

      <div>
        <label className="text-[10px] font-medium text-[var(--text-tertiary)] mb-1 block">Proyecto</label>
        <select
          value={selProject}
          onChange={(e) => setSelProject(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-[var(--surface-2)] border border-[var(--border-default)] rounded-lg text-white"
        >
          <option value="">— Seleccionar proyecto —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

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

      {status && (
        <div className="text-xs text-amber-400 bg-amber-400/10 rounded-lg px-3 py-2 animate-pulse">
          {status}
        </div>
      )}

      {selChapter && !loading && (
        <button
          onClick={handleLoad}
          className="w-full py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          🚀 Cargar en Timeline
        </button>
      )}

      {loading && (
        <div className="w-full py-2.5 text-sm font-medium text-center text-indigo-300 bg-indigo-600/30 rounded-lg">
          ⏳ Procesando...
        </div>
      )}
    </div>
  )
}

/* ── Loaded Chapter Info ── */
function LoadedInfo({
  data,
  source,
  hasTiming,
  onLoadAnother,
  onClear,
  onOpenProduction,
  onRefreshVideos,
  onDeleteAllVideos,
  isRefreshing,
}: {
  data: ZentrixEditorData
  source: ZentrixSource
  hasTiming: boolean
  onLoadAnother: () => void
  onClear: () => void
  onOpenProduction?: () => void
  onRefreshVideos?: () => void
  onDeleteAllVideos?: () => void
  isRefreshing?: boolean
}) {
  const videoCount = data.scenes.filter((s) => s.video_url).length
  const imageCount = data.scenes.filter((s) => s.image_url && !s.video_url).length

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-green-400">✅ Capítulo cargado</div>
        <span className="text-[9px] px-2 py-0.5 rounded-full bg-indigo-600/30 text-indigo-300 border border-indigo-700">
          {SOURCE_META[source].icon} {SOURCE_META[source].label}
        </span>
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
        <div className="text-[10px]">
          {hasTiming ? (
            <span className="text-green-400">🤖 Tiempos analizados por Gemini</span>
          ) : (
            <span className="text-[var(--text-tertiary)]">📐 Tiempos calculados (sin Gemini)</span>
          )}
        </div>
      </div>

      {/* PRODUCTION BUTTON - opens fullscreen modal */}
      {imageCount > 0 && onOpenProduction && (
        <button
          onClick={onOpenProduction}
          className="w-full py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          🎬 Producir Capítulo
        </button>
      )}

      {/* Refresh videos from backend */}
      {onRefreshVideos && (
        <button
          onClick={onRefreshVideos}
          disabled={isRefreshing}
          className="w-full py-2 text-xs text-amber-400 hover:text-amber-300 border border-amber-800 hover:border-amber-600 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {isRefreshing ? "⏳ Actualizando..." : "🔄 Actualizar Videos"}
        </button>
      )}

      {/* Delete all videos — solo Image Studio (Storyboard aún no tiene ese endpoint) */}
      {videoCount > 0 && source === "image-studio" && onDeleteAllVideos && (
        <button
          onClick={() => {
            if (window.confirm("¿Borrar TODOS los videos de este capítulo? Las imágenes se mantienen.")) {
              onDeleteAllVideos()
            }
          }}
          className="w-full py-2 text-xs text-red-400 hover:text-red-300 border border-red-900 hover:border-red-700 rounded-lg transition-colors"
        >
          🗑 Borrar todos los videos
        </button>
      )}

      <button
        onClick={onLoadAnother}
        className="w-full py-2 text-xs text-[var(--text-secondary)] hover:text-white border border-[var(--border-default)] hover:border-[var(--border-strong)] rounded-lg transition-colors"
      >
        Cargar otro capítulo
      </button>
      <button
        onClick={onClear}
        className="w-full py-2 text-xs text-red-400 hover:text-red-300 border border-red-900 hover:border-red-700 rounded-lg transition-colors"
      >
        🗑 Limpiar proyecto
      </button>
    </div>
  )
}

/* ── Main Panel ── */
export const ZentrixPanel = memo(function ZentrixPanel({ onClose, onLoadChapter, onClearProject, onOpenProduction }: ZentrixPanelProps) {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window !== "undefined") return localStorage.getItem(TOKEN_KEY)
    return null
  })
  const [loginError, setLoginError] = useState("")
  const [loadedData, setLoadedData] = useState<ZentrixEditorData | null>(null)
  const [loadedChapterId, setLoadedChapterId] = useState<string | null>(null)
  const [loadedSource, setLoadedSource] = useState<ZentrixSource>("image-studio")
  const [hasTiming, setHasTiming] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

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

  /* Sesión caducada en cualquier petición → borra el token malo y vuelve al login
     con un aviso claro (en vez de dejar el desplegable vacío con el error rojo). */
  const handleAuthExpired = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setLoadedData(null)
    setLoadedChapterId(null)
    setLoginError("Tu sesión expiró. Vuelve a iniciar sesión.")
  }, [])

  const handleLoad = useCallback(
    (result: ZentrixChapterWithTiming) => {
      setLoadedData(result.data)
      setLoadedChapterId(result.chapterId)
      setLoadedSource(result.source)
      setHasTiming(!!result.timing)
      onLoadChapter(result)
    },
    [onLoadChapter],
  )

  const handleRefreshVideos = useCallback(async () => {
    if (!loadedChapterId || !token) return
    setIsRefreshing(true)
    try {
      const data: ZentrixEditorData = await apiFetch(
        `/api/${loadedSource}/chapters/${loadedChapterId}/editor-data`,
        token,
      )
      setLoadedData(data)
      onLoadChapter({ data, timing: null, chapterId: loadedChapterId, source: loadedSource })
    } catch (e: unknown) {
      if (isAuthError(e)) handleAuthExpired()
      else console.error("Refresh failed:", e)
    } finally {
      setIsRefreshing(false)
    }
  }, [loadedChapterId, token, loadedSource, onLoadChapter, handleAuthExpired])

  const handleDeleteAllVideos = useCallback(async () => {
    if (!loadedChapterId || !token) return
    // Solo Image Studio tiene borrado masivo de videos por ahora.
    if (loadedSource !== "image-studio") return
    try {
      await apiFetch(`/api/image-studio/chapters/${loadedChapterId}/all-videos`, token, { method: "DELETE" })
      const data: ZentrixEditorData = await apiFetch(
        `/api/${loadedSource}/chapters/${loadedChapterId}/editor-data`,
        token,
      )
      setLoadedData(data)
      onLoadChapter({ data, timing: null, chapterId: loadedChapterId, source: loadedSource })
    } catch (e: unknown) {
      if (isAuthError(e)) handleAuthExpired()
      else console.error("Delete videos failed:", e)
    }
  }, [loadedChapterId, token, loadedSource, onLoadChapter, handleAuthExpired])

  return (
    <div className="flex h-full w-[320px] flex-col border-r border-[var(--border-default)] bg-[var(--surface-0)]">
      <div className="flex h-10 items-center justify-between border-b border-[var(--border-default)] px-4">
        <span className="text-xs font-semibold text-white">Zentrix</span>
        <button
          onClick={onClose}
          className="text-[var(--text-tertiary)] hover:text-white transition-colors"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!token ? (
          <LoginForm onLogin={handleLogin} error={loginError} />
        ) : loadedData ? (
          <LoadedInfo data={loadedData} source={loadedSource} hasTiming={hasTiming} onLoadAnother={() => { setLoadedData(null); setLoadedChapterId(null); }} onClear={() => { setLoadedData(null); setLoadedChapterId(null); onClearProject(); }} onOpenProduction={onOpenProduction} onRefreshVideos={handleRefreshVideos} onDeleteAllVideos={handleDeleteAllVideos} isRefreshing={isRefreshing} />
        ) : (
          <ChapterSelector token={token} onLoad={handleLoad} onLogout={handleLogout} onAuthExpired={handleAuthExpired} />
        )}
      </div>

      <div className="border-t border-[var(--border-default)] px-4 py-2">
        <div className="text-[9px] text-[var(--text-tertiary)] text-center">
          {token ? "🟢 Conectado a Zentrix" : "🔴 No conectado"}
        </div>
      </div>
    </div>
  )
})

export default ZentrixPanel
