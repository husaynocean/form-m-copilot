import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Form M Copilot",
  description: "An AI agent that checks Nigerian import documents for Form M errors before they reach the bank. Built on Meta's Muse Spark Open.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#030a07" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@500;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
