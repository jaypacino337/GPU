"use client";

import { useEffect, useState } from "react";

/**
 * Rarity ranks, produced by `npm run rarity` and served as a static file.
 *
 * Ranks never change once the collection is fixed, so this is computed once at
 * build time rather than derived per request. Ships as `{}` until the script has
 * run against the real metadata; a missing or empty file degrades to "no rank
 * shown" rather than breaking the page.
 */

export type RarityMap = Record<string, { rank: number; score: number }>;

let cache: RarityMap | null = null;
let inflight: Promise<RarityMap> | null = null;

export async function loadRarity(): Promise<RarityMap> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = fetch("/rarity.json")
    .then((r) => (r.ok ? r.json() : {}))
    .then((json: RarityMap) => {
      cache = json ?? {};
      return cache;
    })
    .catch(() => {
      cache = {};
      return cache;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function useRarity() {
  const [map, setMap] = useState<RarityMap>({});

  useEffect(() => {
    let cancelled = false;
    void loadRarity().then((m) => {
      if (!cancelled) setMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Rank for a piece index, or undefined when ranks are not available yet. */
  return (index: number | undefined): number | undefined => {
    if (index === undefined) return undefined;
    return map[String(index)]?.rank;
  };
}
