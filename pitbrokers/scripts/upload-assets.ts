/**
 * Estimate, then (only with --confirm) upload the collection to Arweave via Irys.
 *
 * The spec asks to see the cost before anything is spent, so this script
 * ALWAYS prints a quote and EXITS unless `--confirm` is passed. There is no way
 * to spend money by running it without reading a number first.
 *
 *   npx ts-node scripts/upload-assets.ts                # quote only
 *   npx ts-node scripts/upload-assets.ts --confirm      # quote, then upload
 *
 * Env:
 *   ASSETS_DIR   default assets/collection
 *   IRYS_NETWORK devnet | mainnet   (default devnet)
 *   ANCHOR_WALLET path to the funding keypair
 *
 * Expects ASSETS_DIR to contain 0.png…999.png and 0.json…999.json.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { Keypair } from "@solana/web3.js";

const ASSETS_DIR = process.env.ASSETS_DIR ?? "assets/collection";
const NETWORK = (process.env.IRYS_NETWORK ?? "devnet") as "devnet" | "mainnet";
const CONFIRM = process.argv.includes("--confirm");
const EXPECTED = 1000;

function loadKeypair(): Keypair {
  const file = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(
    /^~/,
    os.homedir(),
  );
  if (!fs.existsSync(file)) {
    throw new Error(`Keypair not found at ${file}. Set ANCHOR_WALLET.`);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))),
  );
}

interface Tally {
  files: number;
  bytes: number;
  missing: string[];
}

function tally(dir: string): Tally {
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Assets directory "${dir}" does not exist. Drop the finished PNGs and ` +
        "metadata JSON there, or set ASSETS_DIR.",
    );
  }

  let files = 0;
  let bytes = 0;
  const missing: string[] = [];

  for (let i = 0; i < EXPECTED; i++) {
    for (const ext of ["png", "json"]) {
      const file = path.join(dir, `${i}.${ext}`);
      if (fs.existsSync(file)) {
        files += 1;
        bytes += fs.statSync(file).size;
      } else {
        missing.push(`${i}.${ext}`);
      }
    }
  }
  return { files, bytes, missing };
}

/**
 * Metadata sanity. A bad `image` field bakes into 1,000 immutable uploads, so
 * this runs before the money question rather than after.
 */
function validateMetadata(dir: string): string[] {
  const problems: string[] = [];
  const tickerCounts = new Map<string, number>();

  for (let i = 0; i < EXPECTED; i++) {
    const file = path.join(dir, `${i}.json`);
    if (!fs.existsSync(file)) continue;

    let json: {
      name?: string;
      image?: string;
      attributes?: Array<{ trait_type?: string; value?: string }>;
    };
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      problems.push(`${i}.json is not valid JSON`);
      continue;
    }

    if (!json.name) problems.push(`${i}.json has no name`);
    if (!json.image) problems.push(`${i}.json has no image field`);

    const airdrop = json.attributes?.find(
      (a) => a.trait_type?.toLowerCase() === "airdrop",
    )?.value;
    if (airdrop) tickerCounts.set(airdrop, (tickerCounts.get(airdrop) ?? 0) + 1);
  }

  // The airdrop promise is 10 pieces per ticker across 10 tickers.
  const total = [...tickerCounts.values()].reduce((a, b) => a + b, 0);
  if (tickerCounts.size > 0) {
    console.log(`\n  Airdrop attributes found: ${total} across ${tickerCounts.size} tickers`);
    for (const [ticker, count] of [...tickerCounts].sort()) {
      const flag = count === 10 ? "" : "  <-- expected 10";
      console.log(`    ${ticker.padEnd(8)} ${count}${flag}`);
    }
    if (total !== 100) {
      problems.push(`Expected 100 airdrop pieces in total, found ${total}`);
    }
  }

  return problems;
}

async function main() {
  console.log(`Assets:  ${ASSETS_DIR}`);
  console.log(`Network: irys ${NETWORK}`);

  const { files, bytes, missing } = tally(ASSETS_DIR);
  const mb = bytes / 1_000_000;

  console.log(`\n  ${files} / ${EXPECTED * 2} files, ${mb.toFixed(2)} MB total`);

  if (missing.length) {
    console.log(`\n  MISSING ${missing.length} file(s):`);
    console.log(`    ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}`);
    throw new Error("Refusing to upload an incomplete collection.");
  }

  const problems = validateMetadata(ASSETS_DIR);
  if (problems.length) {
    console.log("\n  METADATA PROBLEMS:");
    for (const p of problems.slice(0, 20)) console.log(`    - ${p}`);
    throw new Error(
      "Fix the metadata first — uploads are immutable, so a bad field is permanent.",
    );
  }

  // Import lazily so a quote-only run does not require the Irys deps to load.
  const { Uploader } = await import("@irys/upload");
  const { Solana } = await import("@irys/upload-solana");

  const keypair = loadKeypair();

  // `.devnet()` / `.withRpc()` live on the BUILDER, so they must be chained
  // before the await — the builder is thenable, and awaiting it first yields a
  // BaseNodeIrys that has no such methods.
  let builder = Uploader(Solana).withWallet(keypair.secretKey);
  if (NETWORK === "devnet") {
    builder = builder
      .devnet()
      .withRpc(process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com");
  }
  const uploader = await builder;

  const price = await uploader.getPrice(bytes);
  const sol = Number(price) / 1e9;
  const balance = await uploader.getBalance();

  console.log("\n  ────────────────────────────────────────");
  console.log(`  Upload cost: ${sol.toFixed(6)} SOL`);
  console.log(`  Your Irys balance: ${(Number(balance) / 1e9).toFixed(6)} SOL`);
  console.log(`  Payer: ${keypair.publicKey.toBase58()}`);
  console.log("  ────────────────────────────────────────");

  if (!CONFIRM) {
    console.log(
      "\n  Quote only — nothing was uploaded and nothing was spent.\n" +
        "  Re-run with --confirm to upload.\n",
    );
    return;
  }

  if (BigInt(balance.toString()) < BigInt(price.toString())) {
    const needed = BigInt(price.toString()) - BigInt(balance.toString());
    console.log(`\n  Funding Irys with ${Number(needed) / 1e9} SOL…`);
    await uploader.fund(needed.toString());
  }

  console.log("\n  Uploading…");
  const result = await uploader.uploadFolder(ASSETS_DIR, {
    indexFile: undefined,
    batchSize: 20,
    keepDeleted: false,
  });

  if (!result) throw new Error("Upload returned no manifest.");

  const manifestId = result.id;
  const baseUri = `https://gateway.irys.xyz/${manifestId}/`;

  console.log("\n  ✓ Uploaded");
  console.log(`  Manifest: ${manifestId}`);
  console.log(`  Base URI: ${baseUri}`);
  console.log(
    "\n  NEXT: verify a sample before initializing the program —\n" +
      `    curl -s ${baseUri}0.json | head\n` +
      `    curl -s ${baseUri}999.json | head\n` +
      "  then pass this base URI (WITH the trailing slash) to initialize.\n",
  );
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message ?? e}\n`);
  process.exit(1);
});
