"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { ADMIN_WALLET } from "@config";

// The wallet button touches `window` on mount, so it must not be server-rendered.
const WalletMultiButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false, loading: () => <div className="h-11 w-40 bg-edge" /> },
);

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/mint", label: "Mint" },
  { href: "/my-brokers", label: "My Brokers" },
  { href: "/gallery", label: "Gallery" },
  { href: "/airdrop", label: "Airdrop" },
  { href: "/docs", label: "Docs" },
];

export function Nav() {
  const pathname = usePathname();
  const { publicKey } = useWallet();
  const [open, setOpen] = useState(false);

  // Cosmetic only. The admin page re-checks this, and every privileged action is
  // enforced on-chain by the program authority — hiding a link is not security.
  const isAdmin =
    !!publicKey && ADMIN_WALLET !== "SET_ME" && publicKey.toBase58() === ADMIN_WALLET;

  const links = isAdmin ? [...LINKS, { href: "/admin", label: "Admin" }] : LINKS;

  return (
    <header className="sticky top-0 z-40 border-b-2 border-edge bg-ink/95 backdrop-blur-none">
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="font-display text-lg text-neon">
          PUMP<span className="text-bone">BROKERS</span>
        </Link>

        <ul className="hidden items-center gap-1 md:flex">
          {links.map((link) => {
            const active =
              link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={`px-3 py-2 font-display text-xs uppercase tracking-wide ${
                    active ? "text-neon" : "text-muted hover:text-bone"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-2">
          <WalletMultiButton />
          <button
            type="button"
            className="btn-ghost px-3 md:hidden"
            aria-expanded={open}
            aria-label="Toggle navigation"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "✕" : "☰"}
          </button>
        </div>
      </nav>

      {open && (
        <ul className="border-t-2 border-edge md:hidden">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={() => setOpen(false)}
                className="block border-b border-edge px-4 py-4 font-display text-sm uppercase text-bone"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
