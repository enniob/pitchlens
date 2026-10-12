import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

// Self-hosted by Next at build time: no font requests at runtime.
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "PitchLens — synthetic match viewer",
  description: "Watch a synthetic football match like a TV broadcast: 3D replay, live moments, stats and formations.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b1622",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
