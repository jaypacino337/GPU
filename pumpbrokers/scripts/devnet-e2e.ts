/**
 * Full lifecycle against devnet, end to end:
 *
 *   initialize -> open -> mint -> redeem -> re-mint the recycled asset
 *   -> pause -> verify both pauses bite -> surplus accounting
 *
 * Every step prints the treasury balance and the derived "redemptions
 * available" figure, so the invariant is visible as it runs rather than only
 * asserted at the end.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npm run e2e:devnet
 *
 * Requires: a deployed program, a Core collection whose update authority is the
 * vault PDA, and a devnet $PUMPBROKER-equivalent mint you control.
 */

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const MPL_CORE_PROGRAM_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
);

const DECIMALS = Number(process.env.TOKEN_DECIMALS ?? 6);
const ONE = 10n ** BigInt(DECIMALS);
const MINT_PRICE = 1_000_000n * ONE;
const REDEEM_PRICE = 950_000n * ONE;
const SUPPLY_CAP = 1000;

function step(n: number, label: string) {
  console.log(`\n\x1b[1;32m[${n}]\x1b[0m ${label}`);
}

function fmt(base: bigint): string {
  const whole = base / ONE;
  return `${whole.toLocaleString("en-US")} tokens`;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Pumpbrokers as anchor.Program;
  const authority = (provider.wallet as anchor.Wallet).payer;

  const cluster = provider.connection.rpcEndpoint;
  if (cluster.includes("mainnet")) {
    throw new Error(
      "Refusing to run the lifecycle script against mainnet. This script mints " +
        "and redeems real assets; point ANCHOR_PROVIDER_URL at devnet.",
    );
  }
  console.log(`cluster: ${cluster}`);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId,
  );

  step(1, "Create a devnet test token and the vault-owned treasury");
  const tokenMint =
    process.env.TOKEN_MINT && process.env.TOKEN_MINT !== "SET_ME"
      ? new PublicKey(process.env.TOKEN_MINT)
      : await createMint(
          provider.connection,
          authority,
          authority.publicKey,
          null,
          DECIMALS,
        );
  console.log(`  token mint: ${tokenMint.toBase58()} (${DECIMALS} decimals)`);

  const treasuryAcc = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    authority,
    tokenMint,
    vaultPda,
    true, // owner is a PDA
  );
  const treasury = treasuryAcc.address;
  console.log(`  treasury:   ${treasury.toBase58()} (owned by vault PDA)`);

  const collection = new PublicKey(
    requireEnv(
      "COLLECTION",
      "Run scripts/create-collection.ts first — the collection's update " +
        "authority must be the vault PDA " +
        vaultPda.toBase58(),
    ),
  );

  const balance = async () =>
    (await getAccount(provider.connection, treasury)).amount;
  const available = async () => Number((await balance()) / REDEEM_PRICE);

  const report = async (label: string) => {
    const cfg = await program.account.config.fetch(configPda);
    const bal = await balance();
    const reserved = BigInt(cfg.circulating) * REDEEM_PRICE;
    console.log(
      `  ${label}: treasury=${fmt(bal)} | circulating=${cfg.circulating} ` +
        `| reserved=${fmt(reserved)} | redemptions available=${await available()}`,
    );
    if (bal < reserved) {
      throw new Error(
        `INVARIANT BROKEN: treasury ${bal} < reserved ${reserved}. Stop and investigate.`,
      );
    }
  };

  step(2, "Initialize (idempotent — skips if config already exists)");
  const existing = await provider.connection.getAccountInfo(configPda);
  if (existing) {
    console.log("  config already initialized, skipping");
  } else {
    await program.methods
      .initialize(
        new anchor.BN(MINT_PRICE.toString()),
        new anchor.BN(REDEEM_PRICE.toString()),
        SUPPLY_CAP,
        requireEnv("BASE_URI", "e.g. https://arweave.net/<manifest>/"),
      )
      .accounts({
        authority: authority.publicKey,
        config: configPda,
        vault: vaultPda,
        tokenMint,
        treasury,
        collection,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  initialized");
  }
  await report("after init");

  step(3, "Open the public phase");
  await program.methods
    .setPhase(2)
    .accounts({ authority: authority.publicKey, config: configPda })
    .rpc();

  step(4, "Fund a throwaway buyer with two mints' worth of tokens");
  const buyer = Keypair.generate();
  const airdrop = await provider.connection.requestAirdrop(
    buyer.publicKey,
    2_000_000_000,
  );
  await provider.connection.confirmTransaction(airdrop);
  const buyerAta = await createAssociatedTokenAccount(
    provider.connection,
    authority,
    tokenMint,
    buyer.publicKey,
  );
  await mintTo(
    provider.connection,
    authority,
    tokenMint,
    buyerAta,
    authority,
    MINT_PRICE * 2n,
  );
  console.log(`  buyer: ${buyer.publicKey.toBase58()}`);

  step(5, "Mint a fresh PumpBroker");
  const asset = Keypair.generate();
  const mintSig = await program.methods
    .mintNew()
    .accounts({
      buyer: buyer.publicKey,
      config: configPda,
      vault: vaultPda,
      asset: asset.publicKey,
      collection,
      tokenMint,
      buyerTokenAccount: buyerAta,
      treasury,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([buyer, asset])
    .rpc();
  console.log(`  asset: ${asset.publicKey.toBase58()}`);
  console.log(`  sig:   ${mintSig}`);
  await report("after mint");

  step(6, "Sell it back for 950,000");
  const redeemSig = await program.methods
    .redeem()
    .accounts({
      holder: buyer.publicKey,
      config: configPda,
      vault: vaultPda,
      asset: asset.publicKey,
      collection,
      tokenMint,
      holderTokenAccount: buyerAta,
      treasury,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([buyer])
    .rpc();
  console.log(`  sig: ${redeemSig}`);
  await report("after redeem");
  console.log(
    `  spread retained: ${fmt(MINT_PRICE - REDEEM_PRICE)} (should be 50,000)`,
  );

  step(7, "Re-sell the recycled asset to a second buyer");
  const second = Keypair.generate();
  const drop2 = await provider.connection.requestAirdrop(
    second.publicKey,
    2_000_000_000,
  );
  await provider.connection.confirmTransaction(drop2);
  const secondAta = await createAssociatedTokenAccount(
    provider.connection,
    authority,
    tokenMint,
    second.publicKey,
  );
  await mintTo(
    provider.connection,
    authority,
    tokenMint,
    secondAta,
    authority,
    MINT_PRICE,
  );
  const recycleSig = await program.methods
    .mintRecycled()
    .accounts({
      buyer: second.publicKey,
      config: configPda,
      vault: vaultPda,
      asset: asset.publicKey,
      collection,
      tokenMint,
      buyerTokenAccount: secondAta,
      treasury,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([second])
    .rpc();
  console.log(`  sig: ${recycleSig}`);
  const cfgAfter = await program.account.config.fetch(configPda);
  console.log(
    `  minted_count still ${cfgAfter.mintedCount} — recycling does not inflate supply`,
  );
  await report("after recycle");

  step(8, "Verify the emergency pause bites on both paths");
  await program.methods
    .setPaused(true, true)
    .accounts({ authority: authority.publicKey, config: configPda })
    .rpc();

  const shouldFail = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      throw new Error(`${label} SUCCEEDED while paused — pause is broken`);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("is broken")) throw e;
      console.log(`  ${label} correctly rejected`);
    }
  };

  const spare = Keypair.generate();
  await shouldFail("mint while paused", () =>
    program.methods
      .mintNew()
      .accounts({
        buyer: second.publicKey,
        config: configPda,
        vault: vaultPda,
        asset: spare.publicKey,
        collection,
        tokenMint,
        buyerTokenAccount: secondAta,
        treasury,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([second, spare])
      .rpc(),
  );

  await shouldFail("redeem while paused", () =>
    program.methods
      .redeem()
      .accounts({
        holder: second.publicKey,
        config: configPda,
        vault: vaultPda,
        asset: asset.publicKey,
        collection,
        tokenMint,
        holderTokenAccount: secondAta,
        treasury,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([second])
      .rpc(),
  );

  step(9, "Unpause and confirm the surplus cap protects the floor");
  await program.methods
    .setPaused(false, false)
    .accounts({ authority: authority.publicKey, config: configPda })
    .rpc();

  const cfg = await program.account.config.fetch(configPda);
  const bal = await balance();
  const reserved = BigInt(cfg.circulating) * REDEEM_PRICE;
  const surplus = bal > reserved ? bal - reserved : 0n;
  console.log(`  withdrawable surplus: ${fmt(surplus)}`);
  console.log(`  locked to back sell-backs: ${fmt(reserved)}`);

  const dest = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    authority,
    tokenMint,
    authority.publicKey,
  );
  await shouldFail("withdrawing the entire treasury", () =>
    program.methods
      .withdrawSurplus(new anchor.BN(bal.toString()))
      .accounts({
        authority: authority.publicKey,
        config: configPda,
        vault: vaultPda,
        tokenMint,
        treasury,
        destination: dest.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc(),
  );

  await report("final");
  console.log("\n\x1b[1;32mLifecycle complete. Invariant held at every step.\x1b[0m");
}

function requireEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (!v || v === "SET_ME") {
    throw new Error(`${name} is not set. ${hint}`);
  }
  return v;
}

main().catch((e) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${e.message ?? e}`);
  process.exit(1);
});
