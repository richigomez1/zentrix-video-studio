import { NextRequest, NextResponse } from "next/server"

export const maxDuration = 120 // Allow up to 2 minutes for audio analysis

interface SceneInput {
  index: number
  text_excerpt: string
  image_prompt: string
}

interface TimingResult {
  index: number
  start_time: number
  end_time: number
  duration: number
}

/* Reparto uniforme — cubre TODO el audio. Usado si Gemini falla o devuelve algo inválido. */
function evenSplit(scenes: SceneInput[], audioDuration: number): TimingResult[] {
  const n = scenes.length || 1
  const per = audioDuration / n
  return scenes.map((s, i) => ({
    index: s.index,
    start_time: +(i * per).toFixed(2),
    end_time: +((i + 1) * per).toFixed(2),
    duration: +per.toFixed(2),
  }))
}

/* Garantiza que los tiempos cubran EXACTAMENTE el audio:
   - ordena por index
   - hace los tramos contiguos (cada uno empieza donde termina el anterior)
   - escala las duraciones para que sumen la duración real del audio
   - la última escena termina justo en audioDuration → la voz NUNCA se corta */
function enforceFullCoverage(
  timing: TimingResult[],
  scenes: SceneInput[],
  audioDuration: number,
): TimingResult[] {
  if (!timing.length) return evenSplit(scenes, audioDuration)

  // Mapa de duración por index (a partir de lo que dijo Gemini)
  const durByIndex = new Map<number, number>()
  for (const t of timing) {
    const d = (t.end_time ?? 0) - (t.start_time ?? 0)
    durByIndex.set(t.index, d > 0.3 ? d : 0.5)
  }

  // Recorremos las escenas EN ORDEN (no confiamos en el orden de Gemini)
  const ordered = [...scenes].sort((a, b) => a.index - b.index)
  const rawDurations = ordered.map((s) => durByIndex.get(s.index) ?? 0)
  const sum = rawDurations.reduce((a, b) => a + b, 0) || 1
  const scale = audioDuration / sum // estira o encoge para cuadrar con el audio

  const out: TimingResult[] = []
  let cursor = 0
  ordered.forEach((s, i) => {
    let dur = rawDurations[i] * scale
    // La última escena absorbe cualquier resto → termina exacto en audioDuration
    if (i === ordered.length - 1) dur = Math.max(0.5, audioDuration - cursor)
    const start = +cursor.toFixed(2)
    const end = +(cursor + dur).toFixed(2)
    out.push({
      index: s.index,
      start_time: start,
      end_time: end,
      duration: +(end - start).toFixed(2),
    })
    cursor = end
  })
  return out
}

export async function POST(request: NextRequest) {
  try {
    const { audio_url, scenes, audio_duration } = await request.json()

    if (!audio_url || !scenes || !Array.isArray(scenes)) {
      return NextResponse.json({ error: "audio_url and scenes are required" }, { status: 400 })
    }

    const audioDur = Math.round(audio_duration || 0)
    const apiKey = process.env.GEMINI_API_KEY

    // Sin key → reparto uniforme (cubre todo el audio igual)
    if (!apiKey) {
      return NextResponse.json({
        timing: evenSplit(scenes, audioDur),
        total_duration: audioDur,
        scenes_count: scenes.length,
        analyzed_by: "even-split (no api key)",
      })
    }

    // Fetch audio file from R2
    const audioResponse = await fetch(audio_url)
    if (!audioResponse.ok) {
      // No se pudo bajar el audio → reparto uniforme
      return NextResponse.json({
        timing: evenSplit(scenes, audioDur),
        total_duration: audioDur,
        scenes_count: scenes.length,
        analyzed_by: "even-split (audio fetch failed)",
      })
    }

    const audioBuffer = await audioResponse.arrayBuffer()
    const audioBase64 = Buffer.from(audioBuffer).toString("base64")
    const contentType = audioResponse.headers.get("content-type") || "audio/mpeg"

    const sceneDescriptions = scenes
      .map((s: SceneInput) => `Escena ${s.index + 1}: "${s.text_excerpt || s.image_prompt}"`)
      .join("\n")

    const prompt = `Eres un editor de video profesional. Analiza este audio de narración y asigna tiempos exactos a cada escena.

El audio dura EXACTAMENTE ${audioDur} segundos y tiene ${scenes.length} escenas.

Las escenas son:
${sceneDescriptions}

INSTRUCCIONES CRÍTICAS:
1. Escucha el audio completo.
2. Asigna cada escena al segmento de narración correspondiente según el orden y el contenido.
3. Cada escena empieza donde termina la anterior (sin gaps ni superposiciones).
4. Los tiempos DEBEN cubrir TODO el audio: la primera escena empieza en 0 y la ÚLTIMA escena termina EXACTAMENTE en ${audioDur} segundos. Esto es obligatorio: si la última escena termina antes de ${audioDur}, la voz se cortará.
5. Si hay pausas o silencios, inclúyelos en la escena anterior (la imagen se mantiene durante la pausa).
6. Las escenas con más texto o más acción pueden durar más.

RESPONDE ÚNICAMENTE con un JSON array, sin markdown, sin explicación:
[{"index": 0, "start_time": 0, "end_time": 15.5}, {"index": 1, "start_time": 15.5, "end_time": 28.3}, ...]

Cada objeto tiene: index (empezando en 0), start_time (segundos), end_time (segundos). La última entrada debe tener end_time = ${audioDur}.`

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inline_data: { mime_type: contentType, data: audioBase64 } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
        }),
      },
    )

    if (!geminiResponse.ok) {
      const err = await geminiResponse.text()
      console.error("Gemini API error:", err)
      // Gemini falló → reparto uniforme (cubre todo el audio)
      return NextResponse.json({
        timing: evenSplit(scenes, audioDur),
        total_duration: audioDur,
        scenes_count: scenes.length,
        analyzed_by: "even-split (gemini error)",
      })
    }

    const geminiData = await geminiResponse.json()
    const responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || ""

    // Parse JSON from response (handle markdown fences)
    let timing: TimingResult[] = []
    try {
      const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
      timing = JSON.parse(cleaned)
    } catch {
      const match = responseText.match(/\[[\s\S]*\]/)
      if (match) {
        try {
          timing = JSON.parse(match[0])
        } catch {
          timing = []
        }
      }
    }

    // ── CAPA DE SEGURIDAD: pase lo que pase, los tiempos cubren TODO el audio ──
    const safeTiming = enforceFullCoverage(timing, scenes, audioDur)
    const coveredUntil = safeTiming.length ? safeTiming[safeTiming.length - 1].end_time : 0

    return NextResponse.json({
      timing: safeTiming,
      total_duration: audioDur,
      covered_until: coveredUntil,
      fully_covered: Math.abs(coveredUntil - audioDur) < 1.0,
      scenes_count: scenes.length,
      analyzed_by: timing.length ? "gemini-2.0-flash + coverage-fix" : "even-split (gemini empty)",
    })
  } catch (error) {
    console.error("analyze-audio error:", error)
    // Último recurso: intentar reparto uniforme con lo que tengamos
    try {
      const { scenes, audio_duration } = await request.clone().json()
      if (Array.isArray(scenes) && scenes.length) {
        return NextResponse.json({
          timing: evenSplit(scenes, Math.round(audio_duration || 60)),
          analyzed_by: "even-split (exception)",
        })
      }
    } catch {}
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 },
    )
  }
}
