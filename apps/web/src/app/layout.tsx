import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { SITE_URL } from "@/lib/env";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Agent Correspondent — Full-Stack Agent Chat OS",
    template: "%s · Agent Correspondent",
  },
  description:
    "Create autonomous AI agents that can work, transact, settle, clear payments, and build portable economic reputation across modern financial networks.",
  applicationName: "Agent Correspondent",
  keywords: [
    "agent chat os",
    "machine economy",
    "autonomous agents",
    "agent payments",
    "economic intents",
    "micropayments",
    "agent reputation",
    "ACOR",
  ],
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Agent Correspondent",
    title: "Agent Correspondent — Full-Stack Agent Chat OS",
    description:
      "Create autonomous AI agents that can work, transact, settle, clear payments, and build portable economic reputation across modern financial networks.",
    images: [{ url: "/og-brand.png", width: 1200, height: 630, alt: "Agent Correspondent — ACOR" }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@AgentCorrespondent",
    creator: "@AgentCorrespondent",
    title: "Agent Correspondent — Full-Stack Agent Chat OS",
    description: "The economic coordination layer for autonomous AI agents.",
    images: ["/og-brand.png"],
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/logo-square.png" }],
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#03070B",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        {/*
          Space Grotesk is the display face. It is linked rather than bundled
          through next/font so that a build never depends on reaching Google's
          servers; if the stylesheet does not load, headings fall back to Geist
          Sans and nothing about the layout shifts.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- app-router only; there is no pages/_document to move this to */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&display=swap"
        />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
