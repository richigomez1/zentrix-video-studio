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

export async function POST(request: NextRequest) {
  try {
    const { audio_url, scenes, audio_duration } = await request.json()

    if (!audio_url || !scenes || !Array.isArray(scenes)) {
      return NextResponse.json({ error: "audio_url and scenes are required" }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 })
    }

    // Fetch audio file from R2
    const audioResponse = await fetch(audio_url)
    if (!audioResponse.ok) {
      return NextResponse.json({ error: "Failed to fetch audio" }, { status: 500 })
    }

    const audioBuffer = await audioResponse.arrayBuffer()
    const audioBase64 = Buffer.from(audioBuffer).toString("base64")

    // Determine MIME type
    const contentType = audioResponse.headers.get("content-type") || "audio/mpeg"

    // Build scene descriptions for the prompt
    const sceneDescriptions = scenes
      .map((s: SceneInput) => `Escena ${s.index + 1}: "${s.text_excerpt || s.image_prompt}"`)
      .join("\n")

    const prompt = `Eres un editor de video profesional. Analiza este audio de narración y asigna tiempos exactos a cada escena.

El audio dura aproximadamente ${Math.round(audio_duration || 0)} segundos y tiene ${scenes.length} escenas.

Las escenas son:
${sceneDescriptions}

INSTRUCCIONES:
1. Escucha el audio completo
2. Identifica los segmentos de narración (dónde se habla y dónde hay silencio/pausas)
3. Asigna cada escena al segmento de audio correspondiente según el orden y el contenido
4. Cada escena debe empezar donde termina la anterior (sin gaps ni superposiciones)
5. Los tiempos deben cubrir TODO el audio, desde 0 hasta el final
6. Si hay pausas/silencios entre segmentos de habla, inclúyelos en la escena anterior (la imagen se mantiene durante la pausa)
7. Las escenas más importantes o con más texto pueden tener más duración

RESPONDE ÚNICAMENTE con un JSON array, sin markdown, sin explicación:
[{"index": 0, "start_time": 0, "end_time": 15.5}, {"index": 1, "start_time": 15.5, "end_time": 28.3}, ...]

Cada objeto tiene: index (número de escena empezando en 0), start_time (segundos), end_time (segundos).`

    // Call Gemini API
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: contentType,
                    data: audioBase64,
                  },
                },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
          },
        }),
      },
    )

    if (!geminiResponse.ok) {
      const err = await geminiResponse.text()
      console.error("Gemini API error:", err)
      return NextResponse.json({ error: "Gemini API error", details: err }, { status: 500 })
    }

    const geminiData = await geminiResponse.json()

    // Extract text from Gemini response
    const responseText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || ""

    // Parse JSON from response (handle markdown fences)
    let timing: TimingResult[] = []
    try {
      const cleaned = responseText
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim()
      timing = JSON.parse(cleaned)
    } catch {
      // Try to extract JSON array from response
      const match = responseText.match(/\[[\s\S]*\]/)
      if (match) {
        try {
          timing = JSON.parse(match[0])
        } catch {
          console.error("Failed to parse Gemini response:", responseText)
          return NextResponse.json(
            { error: "Failed to parse Gemini response", raw: responseText },
            { status: 500 },
          )
        }
      }
    }

    // Validate and add duration to each entry
    const validatedTiming = timing.map((t: TimingResult) => ({
      index: t.index,
      start_time: t.start_time,
      end_time: t.end_time,
      duration: t.end_time - t.start_time,
    }))

    return NextResponse.json({
      timing: validatedTiming,
      total_duration: audio_duration,
      scenes_count: scenes.length,
      analyzed_by: "gemini-2.0-flash",
    })
  } catch (error) {
    console.error("analyze-audio error:", error)
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 },
    )
  }
}
