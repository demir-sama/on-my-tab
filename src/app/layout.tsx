import type { Metadata, Viewport } from "next";
import { Instrument_Serif, JetBrains_Mono, Inter_Tight } from "next/font/google";
import "./globals.css";

const serif = Instrument_Serif({ variable: "--f-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });
const mono = JetBrains_Mono({ variable: "--f-mono", subsets: ["latin"], weight: ["400", "500", "700"] });
const sans = Inter_Tight({ variable: "--f-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "On My Tab — an agent that buys it for you, inside a tab you seal",
  description:
    "Name a want, seal a spending cap. SERV Reasoning reads live x402 prices, fits a cart, refuses bad deals and asks before it would overspend. Pays on testnet.",
  openGraph: { title: "On My Tab", description: "Your agent shops on your tab — and asks before it overspends." },
};

export const viewport: Viewport = { themeColor: "#15110e", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
