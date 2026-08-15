"use client";

import { useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
// Imported from the individual adapter packages, NOT the `-wallets` bundle:
// that bundle pulls in WalletConnect -> AppKit -> viem -> the entire EVM chain
// registry, which is megabytes of JavaScript for a Solana-only app.
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { CLIENT_RPC_PATH } from "@config";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * `Connection` rejects a relative URL, and these pages are prerendered at build
 * time where there is no `window`. The origin used during prerender is never
 * actually dialled — no RPC call happens server-side — it just has to parse.
 */
function resolveEndpoint(): string {
  if (typeof window !== "undefined") {
    return new URL(CLIENT_RPC_PATH, window.location.origin).toString();
  }
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return new URL(CLIENT_RPC_PATH, base).toString();
}

export function AppWalletProvider({ children }: { children: ReactNode }) {
  // Always our own proxy — never a keyed upstream, which would ship the Helius
  // key to every visitor.
  const endpoint = useMemo(resolveEndpoint, []);

  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      // Backpack registers itself via the Wallet Standard, so it appears in the
      // modal automatically without an adapter entry.
    ],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
