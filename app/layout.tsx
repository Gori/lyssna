import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted, downloaded from the typefaces used on paymanai.com.
// DM Sans is a variable font — a single file covers the 400–700 weight axis.
const dmSans = localFont({
  src: "./fonts/dm-sans-latin.woff2",
  weight: "400 700",
  display: "swap",
  variable: "--ff-sans",
  fallback: ["system-ui", "sans-serif"],
});

const plexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-400-latin.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-mono-500-latin.woff2", weight: "500" },
  ],
  display: "swap",
  variable: "--ff-mono",
  fallback: ["ui-monospace", "monospace"],
});

export const metadata: Metadata = {
  title: "lyssna — speech to markdown",
  description:
    "Turn a meeting recording into a clean, diarized markdown transcript. Swedish and English.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
