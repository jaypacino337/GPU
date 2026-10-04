import type { Metadata, Viewport } from "next";
import { Press_Start_2P, Inter } from "next/font/google";
import "./globals.css";
import { AppWalletProvider } from "@/components/WalletProvider";
import { Nav } from "@/components/Nav";
import { ConfigBanner } from "@/components/ConfigBanner";

// Pixel display face for headings, clean sans for body copy.
const display = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const body = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PitBrokers",
  description:
    "1,000 pixel-art brokers. Mint for 1,000,000 $PUMPBROKER, sell back for 950,000 — a floor enforced by the program, not a promise.",
  openGraph: {
    title: "PitBrokers",
    description: "Mint for 1,000,000 $PUMPBROKER. Sell back for 950,000, any time.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0D10",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-dvh">
        <AppWalletProvider>
          <ConfigBanner />
          <Nav />
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
          <footer className="mt-16 border-t-2 border-edge px-4 py-8">
            <div className="mx-auto max-w-6xl text-xs text-muted">
              <p>
                PitBrokers is an NFT collection with a program-enforced sell-back
                price. It is not an investment product and the floor is denominated
                in $PUMPBROKER, not dollars.{" "}
                <a href="/docs" className="text-neon underline">
                  Read the docs
                </a>{" "}
                before you mint.
              </p>
            </div>
          </footer>
        </AppWalletProvider>
      </body>
    </html>
  );
}
