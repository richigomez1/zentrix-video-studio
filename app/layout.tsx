import type React from "react"
import type { Metadata } from "next"
import { Inter, JetBrains_Mono } from "next/font/google"
import { Suspense } from "react"
import { ErrorBoundary } from "@/seq/components/error-boundary"
import { Toaster, ToastProvider } from "@/seq/components/ui/sonner"
import { DeploymentNotice } from "@/seq/components/deployment-notice"

//@ts-ignore
import "./globals.css"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
})

export const metadata: Metadata = {
  title: "Zentrix Video Studio - Editor de Video con IA",
  description:
    "Estudio de producción de video con IA. Genera imágenes, videos y edita en un timeline profesional para contenido de YouTube.",
  keywords: [
    "zentrix",
    "video editor",
    "AI video generation",
    "timeline editor",
    "video production",
    "youtube content",
  ],
  authors: [{ name: "Zentrix" }],
  creator: "Zentrix",
  publisher: "Zentrix",
  openGraph: {
    type: "website",
    locale: "es_ES",
    title: "Zentrix Video Studio - Editor de Video con IA",
    description:
      "Estudio de producción de video con IA. Genera imágenes, videos y edita en un timeline profesional.",
    siteName: "Zentrix Video Studio",
  },
  twitter: {
    card: "summary_large_image",
    title: "Zentrix Video Studio - Editor de Video con IA",
    description:
      "Estudio de producción de video con IA. Genera imágenes, videos y edita en un timeline profesional.",
  },
  robots: {
    index: false,
    follow: false,
  },
}

export const viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="es"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
      style={{ backgroundColor: "#000000" }}
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className="font-sans antialiased" style={{ backgroundColor: "#000000" }}>
        <ToastProvider>
          <ErrorBoundary>
            <Suspense fallback={null}>{children}</Suspense>
          </ErrorBoundary>
          <Toaster />
          <DeploymentNotice />
        </ToastProvider>
      </body>
    </html>
  )
}
