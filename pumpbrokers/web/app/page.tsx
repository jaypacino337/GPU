"use client";

import Link from "next/link";
import { useCollectionStats } from "@/lib/useCollectionStats";
import { StatTile, StatSkeleton } from "@/components/StatTile";
import { formatTokens, formatCompact, groupDigits } from "@/lib/format";
import {
  MINT_PRICE_TOKENS,
  REDEEM_PRICE_TOKENS,
  SUPPLY_CAP,
  SPREAD_BPS,
  TOKEN,
} from "@config";

export default function LandingPage() {
  const { stats, error, loading } = useCollectionStats();
  const decimals = typeof TOKEN.decimals === "number" ? TOKEN.decimals : 0;

  const minted = stats?.config.mintedCount ?? 0;
  const soldOut = minted >= SUPPLY_CAP;

  return (
    <div className="space-y-12">
      <section className="grid gap-8 md:grid-cols-2 md:items-center">
        <div>
          <p className="tag border-neon text-neon">1,000 pixel brokers</p>
          <h1 className="mt-4 text-2xl leading-relaxed text-bone sm:text-3xl">
            Mint for <span className="text-neon">{groupDigits(MINT_PRICE_TOKENS)}</span>.
            <br />
            Sell back for <span className="text-neon">{groupDigits(REDEEM_PRICE_TOKENS)}</span>.
          </h1>
          <p className="mt-5 max-w-prose text-sm leading-relaxed text-muted">
            Every PumpBroker can be returned to the program for{" "}
            {groupDigits(REDEEM_PRICE_TOKENS)} ${TOKEN.symbol} — {SPREAD_BPS / 100}% below
            what it cost to mint. That spread stays in a program-owned treasury,
            which is what funds the next sell-back. The floor is enforced by the
            program, not promised by us.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Link href="/mint" className="btn-primary">
              {soldOut ? "View gallery" : "Mint a broker"}
            </Link>
            <Link href="/docs" className="btn-ghost">
              How it works
            </Link>
          </div>
        </div>

        <div className="panel-neon aspect-square">
          {/* Hero art is a static export of a representative piece; replaced by
              the real collection preview once assets are uploaded. */}
          <div className="flex h-full w-full items-center justify-center p-6 text-center">
            <p className="font-display text-xs leading-relaxed text-muted">
              Collection preview
              <br />
              <span className="text-neon">available after asset upload</span>
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-sm text-muted">Live numbers</h2>
        {error ? (
          <div className="panel border-down p-4 text-sm text-bone">
            <p className="font-display text-xs text-down">Could not read chain state</p>
            <p className="mt-2 text-muted">{error}</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {loading || !stats ? (
              <>
                <StatSkeleton label="Minted" />
                <StatSkeleton label="Mint price" />
                <StatSkeleton label="Sell-back price" />
                <StatSkeleton label="Treasury" />
              </>
            ) : (
              <>
                <StatTile
                  label="Minted"
                  tone="neon"
                  value={`${stats.config.mintedCount} / ${stats.config.supplyCap}`}
                  hint={`${stats.config.circulating} held by collectors`}
                />
                <StatTile
                  label="Mint price"
                  value={`${formatTokens(stats.config.mintPrice, decimals)}`}
                  hint={`$${TOKEN.symbol}`}
                />
                <StatTile
                  label="Sell-back price"
                  value={`${formatTokens(stats.config.redeemPrice, decimals)}`}
                  hint={`$${TOKEN.symbol}, any time`}
                />
                <StatTile
                  label="Treasury"
                  value={formatCompact(stats.treasury, decimals)}
                  hint={
                    <>
                      Redemptions currently available:{" "}
                      <span
                        className={
                          stats.redemptionsAvailable > 0 ? "text-neon" : "text-down"
                        }
                      >
                        {stats.redemptionsAvailable}
                      </span>
                    </>
                  }
                />
              </>
            )}
          </div>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Explainer title="Hard cap">
          Exactly {SUPPLY_CAP} brokers exist. Supply is tracked by a bitmap in the
          program, so it cannot drift.
        </Explainer>
        <Explainer title="Self-funding floor">
          Every mint puts {groupDigits(MINT_PRICE_TOKENS)} in and every sell-back
          takes {groupDigits(REDEEM_PRICE_TOKENS)} out, so the treasury gains on
          every cycle.
        </Explainer>
        <Explainer title="Recycled, not burned">
          A broker you sell back returns to the mintable pool. The art keeps
          circulating and supply stays at {SUPPLY_CAP}.
        </Explainer>
      </section>
    </div>
  );
}

function Explainer({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel p-4">
      <h3 className="font-display text-xs text-neon">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}
