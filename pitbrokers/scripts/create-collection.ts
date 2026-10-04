/**
 * Create the Metaplex Core collection.
 *
 * THE UPDATE AUTHORITY MUST BE THE VAULT PDA. `mint_new` signs asset creation
 * into the collection as that PDA; if the authority is anything else, minting
 * can never work and the collection has to be recreated. The script derives the
 * PDA itself rather than accepting it as an argument, and verifies it after
 * creation.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   BASE_URI=https://gateway.irys.xyz/<manifest>/ \
 *   npx ts-node scripts/create-collection.ts
 */

import fs from "fs";
import os from "os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  createCollection,
  fetchCollectionV1,
  mplCore,
} from "@metaplex-foundation/mpl-core";
import {
  generateSigner,
  keypairIdentity,
  publicKey as toUmiPublicKey,
} from "@metaplex-foundation/umi";

const RPC = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = process.env.PROGRAM_ID ?? process.env.NEXT_PUBLIC_PROGRAM_ID;
const BASE_URI = process.env.BASE_URI;

function loadKeypair(): Keypair {
  const file = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(
    /^~/,
    os.homedir(),
  );
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))),
  );
}

async function main() {
  if (!PROGRAM_ID || PROGRAM_ID === "SET_ME") {
    throw new Error("PROGRAM_ID is not set. Deploy the program first.");
  }
  if (!BASE_URI || BASE_URI === "SET_ME") {
    throw new Error("BASE_URI is not set. Run scripts/upload-assets.ts first.");
  }
  if (!BASE_URI.endsWith("/")) {
    throw new Error(
      `BASE_URI must end with "/" — otherwise metadata URIs become ` +
        `"${BASE_URI}0.json" instead of "${BASE_URI}/0.json".`,
    );
  }
  if (RPC.includes("mainnet")) {
    console.log("\n  ⚠ Creating a collection on MAINNET. This spends real SOL.\n");
  }

  const programId = new PublicKey(PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    programId,
  );

  console.log(`RPC:        ${RPC}`);
  console.log(`Program:    ${programId.toBase58()}`);
  console.log(`Vault PDA:  ${vaultPda.toBase58()}   <- update authority`);
  console.log(`Base URI:   ${BASE_URI}`);

  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Payer:      ${payer.publicKey.toBase58()} (${balance / 1e9} SOL)`);

  if (balance < 0.01e9) {
    throw new Error("Payer has under 0.01 SOL — top it up before continuing.");
  }

  const umi = createUmi(RPC).use(mplCore());
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(payer.secretKey)));

  const collection = generateSigner(umi);

  console.log("\nCreating collection…");
  await createCollection(umi, {
    collection,
    name: "PitBrokers",
    uri: `${BASE_URI}collection.json`,
    // The single most important line in this script.
    updateAuthority: toUmiPublicKey(vaultPda.toBase58()),
  }).sendAndConfirm(umi);

  const address = collection.publicKey.toString();

  // Read it back — a silently-wrong authority is unrecoverable later.
  const fetched = await fetchCollectionV1(umi, collection.publicKey);
  const actual = fetched.updateAuthority.toString();

  console.log(`\n  ✓ Collection: ${address}`);
  console.log(`    Update authority: ${actual}`);

  if (actual !== vaultPda.toBase58()) {
    throw new Error(
      `UPDATE AUTHORITY MISMATCH — expected the vault PDA ${vaultPda.toBase58()} ` +
        `but got ${actual}. Minting would fail. Recreate the collection.`,
    );
  }

  console.log("    Authority verified against the vault PDA.\n");
  console.log("  NEXT:");
  console.log(`    export NEXT_PUBLIC_COLLECTION=${address}`);
  console.log(`    export COLLECTION=${address}`);
  console.log("    then run initialize (scripts/devnet-e2e.ts does this).\n");
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message ?? e}\n`);
  process.exit(1);
});
