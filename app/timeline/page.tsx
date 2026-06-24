import Editor from "@/seq/components/editor/app"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Zentrix Video Studio",
  description: "Editor de video profesional con IA para producción de contenido YouTube",
}

export default function TimelinePage() {
  return <Editor />
}
