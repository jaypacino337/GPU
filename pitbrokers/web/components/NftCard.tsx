"use client";

import { useState } from "react";

export interface BrokerAsset {
  address: string;
  name: string;
  image?: string;
  index?: number;
  /** Rarity rank, 1 = rarest. */
  rank?: number;
  /** Ticker from the `Airdrop` attribute, if this piece carries one. */
  airdropTicker?: string;
  attributes?: Array<{ trait_type: string; value: string }>;
}

export function NftCard({
  asset,
  footer,
  priority = false,
}: {
  asset: BrokerAsset;
  footer?: React.ReactNode;
  priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <article className="panel flex flex-col">
      <div className="relative aspect-square overflow-hidden border-b-2 border-edge bg-ink">
        {asset.image && !failed ? (
          // Plain <img>, not next/image: the whole point is nearest-neighbour
          // scaling, and the optimizer would resample the pixel art.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={asset.image}
            alt={asset.name}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            onError={() => setFailed(true)}
            className="pixelated h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted">
            {failed ? "image unavailable" : "…"}
          </div>
        )}

        {asset.airdropTicker && (
          <span className="tag absolute left-2 top-2 border-neon bg-ink text-neon">
            Airdrop eligible · {asset.airdropTicker}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="font-display text-xs text-bone">{asset.name}</h3>
        {asset.rank !== undefined && (
          <p className="text-xs text-muted">Rarity rank #{asset.rank}</p>
        )}
        {footer && <div className="mt-3">{footer}</div>}
      </div>
    </article>
  );
}

export function NftCardSkeleton() {
  return (
    <div className="panel">
      <div className="aspect-square animate-pulse border-b-2 border-edge bg-edge" />
      <div className="p-3">
        <div className="h-3 w-24 animate-pulse bg-edge" />
      </div>
    </div>
  );
}
