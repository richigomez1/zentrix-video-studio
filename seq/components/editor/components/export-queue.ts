/* ═══════════════════════════════════════════════════════════
   Export Queue — Global singleton that manages export jobs.
   Persists across component mounts/unmounts so exports
   continue when navigating between chapters.
   ═══════════════════════════════════════════════════════════ */

/* ── Types ── */
interface VideoMeta {
  fps: number
  width: number
  height: number
  codec_v: string
  codec_a: string
  has_audio: boolean
}

export interface ExportClip {
  index: number
  videoUrl: string
  duration: number
  volume: number
  meta?: VideoMeta | null
}

export interface ExportJob {
  id: string
  chapterId: string
  chapterLabel: string
  clips: ExportClip[]
  audioUrls: string[]
  resolution: "720p" | "1080p"
  status: "queued" | "loading" | "processing" | "finalizing" | "done" | "error"
  progress: number
  statusMsg: string
  downloadUrl: string | null
  totalMB: string
  clipCount: number
  error: string | null
  startedAt: number | null
}

type Subscriber = () => void

/* ── Module-level state (persists across React mounts) ── */
let jobs: ExportJob[] = []
let worker: Worker | null = null
let activeJobId: string | null = null
let subscribers: Subscriber[] = []
let jobCounter = 0

/* ── Notify all subscribers of state change ── */
function notify() {
  subscribers.forEach((cb) => {
    try { cb() } catch {}
  })
}

/* ── Create or reuse the Web Worker ── */
function getOrCreateWorker(): Worker {
  if (worker) return worker
  const w = new Worker(
    new URL("./export-worker.ts", import.meta.url),
    { type: "module" }
  )
  w.onmessage = handleWorkerMessage
  w.onerror = (e) => {
    const job = jobs.find((j) => j.id === activeJobId)
    if (job) {
      job.status = "error"
      job.error = `Worker error: ${e.message}`
    }
    activeJobId = null
    notify()
    processNext()
  }
  worker = w
  return w
}

/* ── Handle messages from worker ── */
function handleWorkerMessage(e: MessageEvent) {
  const msg = e.data
  const job = jobs.find((j) => j.id === activeJobId)
  if (!job) return

  if (msg.type === "progress") {
    job.status = msg.phase
    job.progress = msg.progress
    job.statusMsg = msg.status
    notify()
  }

  if (msg.type === "done") {
    const blob = new Blob([msg.buffer], { type: "video/mp4" })
    job.downloadUrl = URL.createObjectURL(blob)
    job.totalMB = msg.totalMB
    job.clipCount = msg.clipCount
    job.status = "done"
    job.progress = 100
    job.statusMsg = `${msg.clipCount} clips · ${job.resolution} · ${msg.totalMB} MB`
    activeJobId = null
    notify()
    processNext()
  }

  if (msg.type === "error") {
    job.status = "error"
    job.error = msg.error
    activeJobId = null
    notify()
    processNext()
  }
}

/* ── Process next queued job ── */
function processNext() {
  if (activeJobId) return // already processing
  const next = jobs.find((j) => j.status === "queued")
  if (!next) return

  activeJobId = next.id
  next.status = "loading"
  next.startedAt = Date.now()
  notify()

  const w = getOrCreateWorker()
  w.postMessage({
    type: "start",
    clips: next.clips,
    resolution: next.resolution,
    audioUrls: next.audioUrls,
  })
}

/* ═══════════════════════════════════════════════
   Public API
   ═══════════════════════════════════════════════ */

/** Subscribe to queue state changes. Returns unsubscribe function. */
export function subscribe(cb: Subscriber): () => void {
  subscribers.push(cb)
  return () => {
    subscribers = subscribers.filter((s) => s !== cb)
  }
}

/** Get current snapshot of all jobs */
export function getJobs(): ExportJob[] {
  return jobs
}

/** Get count of active + queued jobs */
export function getPendingCount(): number {
  return jobs.filter((j) => j.status !== "done" && j.status !== "error").length
}

/** Add a new export job to the queue */
export function addExportJob(config: {
  chapterId: string
  chapterLabel: string
  clips: ExportClip[]
  audioUrls: string[]
  resolution: "720p" | "1080p"
}): string {
  jobCounter++
  const id = `export_${jobCounter}_${Date.now()}`
  const job: ExportJob = {
    id,
    chapterId: config.chapterId,
    chapterLabel: config.chapterLabel,
    clips: config.clips,
    audioUrls: config.audioUrls,
    resolution: config.resolution,
    status: "queued",
    progress: 0,
    statusMsg: "En cola...",
    downloadUrl: null,
    totalMB: "",
    clipCount: config.clips.length,
    error: null,
    startedAt: null,
  }
  jobs.push(job)
  notify()
  processNext()
  return id
}

/** Cancel a specific job */
export function cancelJob(jobId: string) {
  const job = jobs.find((j) => j.id === jobId)
  if (!job) return

  if (job.id === activeJobId) {
    // Cancel the active worker
    worker?.postMessage({ type: "cancel" })
    activeJobId = null
    job.status = "error"
    job.error = "Cancelado por el usuario"
    notify()
    processNext()
  } else if (job.status === "queued") {
    // Remove from queue
    jobs = jobs.filter((j) => j.id !== jobId)
    notify()
  }
}

/** Remove completed/errored jobs from the list */
export function clearFinishedJobs() {
  // Revoke blob URLs before removing
  for (const job of jobs) {
    if (job.downloadUrl && (job.status === "done" || job.status === "error")) {
      try { URL.revokeObjectURL(job.downloadUrl) } catch {}
    }
  }
  jobs = jobs.filter((j) => j.status !== "done" && j.status !== "error")
  notify()
}

/** Download a completed job's video */
export function downloadJob(jobId: string) {
  const job = jobs.find((j) => j.id === jobId)
  if (!job || !job.downloadUrl) return
  const a = document.createElement("a")
  a.href = job.downloadUrl
  const safeName = job.chapterLabel.replace(/[^a-zA-Z0-9_-]/g, "_") || "zentrix_export"
  a.download = `${safeName}.mp4`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
