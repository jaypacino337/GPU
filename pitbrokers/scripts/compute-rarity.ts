/**
 * Compute rarity ranks from the collection metadata.
 *
 * Uses the standard trait-rarity score: for each trait a piece has, add
 * 1 / (frequency of that value). Rarer values contribute more. Rank 1 is rarest.
 *
 * Writes `web/public/rarity.json` as `{ "<index>": { rank, score } }`, which the
 * gallery and My Brokers read to show a rank per piece. Deliberately a static
 * file rather than a runtime computation — it never changes once the collection
 * is fixed, so computing it per request would be pure waste.
 *
 *   npx ts-node scripts/compute-rarity.ts
 */

import fs from "fs";
import path from "path";

const ASSETS_DIR = process.env.ASSETS_DIR ?? "assets/collection";
const OUT = process.env.RARITY_OUT ?? "web/public/rarity.json";
const SUPPLY = 1000;

interface Metadata {
  name?: string;
  attributes?: Array<{ trait_type?: string; value?: string }>;
}

interface Piece {
  index: number;
  traits: Array<{ type: string; value: string }>;
  score: number;
}

function main() {
  if (!fs.existsSync(ASSETS_DIR)) {
    throw new Error(`Assets directory "${ASSETS_DIR}" does not exist.`);
  }

  const pieces: Piece[] = [];
  // trait_type -> value -> count
  const frequency = new Map<string, Map<string, number>>();

  for (let i = 0; i < SUPPLY; i++) {
    const file = path.join(ASSETS_DIR, `${i}.json`);
    if (!fs.existsSync(file)) continue;

    const meta: Metadata = JSON.parse(fs.readFileSync(file, "utf8"));
    const traits = (meta.attributes ?? [])
      .filter((a): a is { trait_type: string; value: string } =>
        typeof a.trait_type === "string" && typeof a.value === "string",
      )
      .map((a) => ({ type: a.trait_type, value: a.value }));

    for (const t of traits) {
      const byValue = frequency.get(t.type) ?? new Map<string, number>();
      byValue.set(t.value, (byValue.get(t.value) ?? 0) + 1);
      frequency.set(t.type, byValue);
    }

    pieces.push({ index: i, traits, score: 0 });
  }

  if (pieces.length === 0) {
    throw new Error(`No metadata found in ${ASSETS_DIR}.`);
  }
  if (pieces.length !== SUPPLY) {
    console.log(
      `  ⚠ Found ${pieces.length} pieces, expected ${SUPPLY}. Ranks are relative ` +
        "to what was found.",
    );
  }

  for (const piece of pieces) {
    let score = 0;
    for (const t of piece.traits) {
      const count = frequency.get(t.type)?.get(t.value) ?? 1;
      score += pieces.length / count;
    }
    piece.score = score;
  }

  // Highest score = rarest = rank 1. Ties broken by index so ranks are stable
  // across runs — an unstable rank would silently reshuffle the gallery.
  const ranked = [...pieces].sort((a, b) => b.score - a.score || a.index - b.index);

  const out: Record<string, { rank: number; score: number }> = {};
  ranked.forEach((piece, i) => {
    out[String(piece.index)] = {
      rank: i + 1,
      score: Number(piece.score.toFixed(4)),
    };
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0));

  console.log(`\n  Wrote ${OUT} (${ranked.length} pieces)\n`);
  console.log("  Trait distribution:");
  for (const [type, values] of [...frequency].sort()) {
    console.log(`    ${type} — ${values.size} distinct values`);
  }

  console.log("\n  Rarest 5:");
  for (const piece of ranked.slice(0, 5)) {
    console.log(`    #${piece.index}  score ${piece.score.toFixed(2)}`);
  }
  console.log("\n  Most common 5:");
  for (const piece of ranked.slice(-5)) {
    console.log(`    #${piece.index}  score ${piece.score.toFixed(2)}`);
  }
  console.log("");
}

try {
  main();
} catch (e) {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
}
