"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useCollectionStats } from "@/lib/useCollectionStats";
import { fetchCollectionPage } from "@/lib/das";
import { NftCard, NftCardSkeleton, type BrokerAsset } from "@/components/NftCard";
import { SUPPLY_CAP } from "@config";

const PAGE_SIZE = 24;

type SortMode = "index" | "rarity";

export default function GalleryPage() {
  const { stats } = useCollectionStats();
  const collection = stats?.config.collection.toBase58();

  const [page, setPage] = useState(1);
  const [items, setItems] = useState<BrokerAsset[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("index");
  const [traitFilter, setTraitFilter] = useState<string>("");

  const load = useCallback(async () => {
    if (!collection) return;
    setItems(null);
    setError(null);
    try {
      const result = await fetchCollectionPage(collection, page, PAGE_SIZE);
      setItems(result.items);
      setTotal(result.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [collection, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Trait values present on the current page. Deriving the full trait universe
  // would mean pulling all 1,000 assets, which is exactly what pagination is
  // here to avoid — so filters apply within the loaded page.
  const traitValues = useMemo(() => {
    const values = new Set<string>();
    for (const item of items ?? []) {
      for (const attr of item.attributes ?? []) {
        values.add(`${attr.trait_type}: ${attr.value}`);
      }
    }
    return [...values].sort();
  }, [items]);

  const visible = useMemo(() => {
    let list = [...(items ?? [])];
    if (traitFilter) {
      list = list.filter((item) =>
        (item.attributes ?? []).some(
          (a) => `${a.trait_type}: ${a.value}` === traitFilter,
        ),
      );
    }
    list.sort((a, b) =>
      sort === "rarity"
        ? (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
        : (a.index ?? 0) - (b.index ?? 0),
    );
    return list;
  }, [items, traitFilter, sort]);

  const totalPages = Math.max(1, Math.ceil((total || SUPPLY_CAP) / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl text-bone">Gallery</h1>
        <p className="mt-2 text-sm text-muted">
          All {SUPPLY_CAP} PitBrokers. Loaded {PAGE_SIZE} at a time — the full set
          is never fetched at once.
        </p>
      </header>

      <div className="panel flex flex-wrap items-center gap-3 p-3">
        <label className="flex items-center gap-2 text-xs text-muted">
          Sort
          <select
            className="border-2 border-edge bg-ink px-2 py-2 font-display text-[10px] uppercase text-bone"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
          >
            <option value="index">By number</option>
            <option value="rarity">By rarity</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-muted">
          Trait
          <select
            className="max-w-[16rem] border-2 border-edge bg-ink px-2 py-2 font-display text-[10px] uppercase text-bone"
            value={traitFilter}
            onChange={(e) => setTraitFilter(e.target.value)}
          >
            <option value="">All traits</option>
            {traitValues.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        {traitFilter && (
          <button
            type="button"
            className="btn-ghost px-3 py-2 text-[10px]"
            onClick={() => setTraitFilter("")}
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div className="panel border-down p-4 text-sm text-bone">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {items === null
          ? Array.from({ length: PAGE_SIZE }, (_, i) => <NftCardSkeleton key={i} />)
          : visible.map((asset, i) => (
              <NftCard key={asset.address} asset={asset} priority={i < 4} />
            ))}
      </div>

      {items !== null && visible.length === 0 && (
        <p className="panel p-6 text-center text-sm text-muted">
          No brokers on this page match that trait.
        </p>
      )}

      <nav className="flex items-center justify-between gap-4">
        <button
          type="button"
          className="btn-ghost"
          disabled={page <= 1 || items === null}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          ← Prev
        </button>
        <p className="font-display text-[10px] uppercase text-muted">
          Page {page} of {totalPages}
        </p>
        <button
          type="button"
          className="btn-ghost"
          disabled={page >= totalPages || items === null}
          onClick={() => setPage((p) => p + 1)}
        >
          Next →
        </button>
      </nav>
    </div>
  );
}
