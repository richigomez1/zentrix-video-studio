"use client"
import { memo, useEffect, useState } from "react"
import { generateWaveform, generateFakeWaveform, type WaveformData } from "../utils/waveform-generator"

interface ClipWaveformProps {
  mediaUrl?: string
  duration: number
  offset: number
  isAudio: boolean
  isSelected: boolean
  zoomLevel: number
}

export const ClipWaveform = memo(
  ({ mediaUrl, duration, offset, isAudio, isSelected, zoomLevel }: ClipWaveformProps) => {
    const [waveformData, setWaveformData] = useState<WaveformData | null>(null)
    const [isLoading, setIsLoading] = useState(false)

    // Más barras y más finas → detalle tipo Premiere
    const clipWidth = duration * zoomLevel
    const numBars = Math.min(600, Math.max(30, Math.floor(clipWidth / 2)))

    useEffect(() => {
      if (!mediaUrl) return
      let cancelled = false
      setIsLoading(true)
      generateWaveform(mediaUrl, numBars).then((data) => {
        if (!cancelled) {
          setWaveformData(data)
          setIsLoading(false)
        }
      })
      return () => {
        cancelled = true
      }
    }, [mediaUrl, numBars])

    const peaks = waveformData?.peaks || generateFakeWaveform(duration, offset, numBars)
    const startIndex = waveformData ? Math.floor((offset / waveformData.duration) * peaks.length) : 0
    const visiblePeaks = waveformData ? peaks.slice(startIndex, startIndex + numBars) : peaks

    // Color de la onda según estado
    const barColor = isSelected
      ? "rgba(255,255,255,0.9)"
      : isAudio
        ? "rgba(52,211,153,0.85)"   // emerald-400 sólido
        : "rgba(255,255,255,0.45)"

    return (
      <div
        className={`w-full h-full flex items-center justify-start gap-[1px] overflow-hidden pointer-events-none transition-opacity ${isLoading ? "opacity-40" : "opacity-95"}`}
        aria-hidden="true"
      >
        {visiblePeaks.map((peak, i) => {
          // Onda SIMÉTRICA (espejo): crece desde el centro hacia arriba y abajo — estilo Premiere/CapCut
          const height = Math.max(6, 8 + peak * 88)
          return (
            <div
              key={i}
              className="flex-1 min-w-[1px] rounded-full"
              style={{
                height: `${height}%`,
                background: barColor,
                alignSelf: "center",
              }}
            />
          )
        })}
      </div>
    )
  },
)

ClipWaveform.displayName = "ClipWaveform"
