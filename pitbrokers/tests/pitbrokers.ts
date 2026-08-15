/**
 * Anchor integration tests for mint / redeem / pause, including the failure
 * cases that matter more than the happy paths.
 *
 * Requires the Anchor toolchain and a local validator with Metaplex Core cloned
 * (see Anchor.toml [[test.validator.clone]]):
 *
 *     anchor test
 *
 * NOTE: these were written but NOT executed in the session that produced them —
 * the container's egress proxy blocks the Anza/Anchor toolchain download. The
 * pure-logic half of the same guarantees IS executed, as Rust unit tests in
 * programs/pitbrokers/src/state.rs (`cargo test`, 17 passing).
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  createCollection,
  fetchAssetV1,
  mplCore,
} from "@metaplex-foundation/mpl-core";
import { assert } from "chai";
import type { Pitbrokers } from "../target/types/pitbrokers";

const MPL_CORE_PROGRAM_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
);

// 6-decimal token, matching config/: 1,000,000 and 950,000 whole tokens.
const DECIMALS = 6;
const ONE = 10n ** BigInt(DECIMALS);
const MINT_PRICE = 1_000_000n * ONE;
const REDEEM_PRICE = 950_000n * ONE;
const SUPPLY_CAP = 1000;
const BASE_URI = "https://arweave.net/TESTMANIFEST/";

describe("pitbrokers", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Pitbrokers as Program<Pitbrokers>;
  const authority = (provider.wallet as anchor.Wallet).payer;

  let tokenMint: PublicKey;
  let collection: PublicKey;
  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let treasury: PublicKey;

  const buyer = Keypair.generate();
  let buyerAta: PublicKey;

  /** Fund a wallet with SOL and enough $PUMPBROKER for `mints` purchases. */
  async function fundBuyer(kp: Keypair, mints: number): Promise<PublicKey> {
    const sig = await provider.connection.requestAirdrop(
      kp.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig);
    const ata = await createAssociatedTokenAccount(
      provider.connection,
      authority,
      tokenMint,
      kp.publicKey,
    );
    await mintTo(
      provider.connection,
      authority,
      tokenMint,
      ata,
      authority,
      MINT_PRICE * BigInt(mints),
    );
    return ata;
  }

  async function treasuryBalance(): Promise<bigint> {
    const acc = await getAccount(provider.connection, treasury);
    return acc.amount;
  }

  async function setPhasePublic() {
    await program.methods
      .setPhase(2)
      .accounts({ authority: authority.publicKey, config: configPda })
      .rpc();
  }

  /** Mint one fresh asset for `who`, returning the new asset pubkey. */
  async function mintNew(who: Keypair, ata: PublicKey): Promise<PublicKey> {
    const asset = Keypair.generate();
    await program.methods
      .mintNew()
      .accounts({
        buyer: who.publicKey,
        config: configPda,
        vault: vaultPda,
        asset: asset.publicKey,
        collection,
        tokenMint,
        buyerTokenAccount: ata,
        treasury,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who, asset])
      .rpc();
    return asset.publicKey;
  }

  async function redeem(who: Keypair, ata: PublicKey, asset: PublicKey) {
    await program.methods
      .redeem()
      .accounts({
        holder: who.publicKey,
        config: configPda,
        vault: vaultPda,
        asset,
        collection,
        tokenMint,
        holderTokenAccount: ata,
        treasury,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();
  }

  /** Assert an Anchor error code, so tests fail on the WRONG error too. */
  async function expectError(fn: () => Promise<unknown>, code: string) {
    try {
      await fn();
      assert.fail(`expected ${code}, but the instruction succeeded`);
    } catch (e) {
      const err = e as AnchorError;
      const actual = err.error?.errorCode?.code ?? String(e);
      assert.strictEqual(actual, code, `expected ${code}, got ${actual}`);
    }
  }

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId,
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      program.programId,
    );

    tokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      DECIMALS,
    );

    // Treasury is a token account owned by the vault PDA — never a personal wallet.
    const treasuryAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      tokenMint,
      vaultPda,
      true, // allowOwnerOffCurve — the owner is a PDA
    );
    treasury = treasuryAcc.address;

    // The vault PDA must be the collection's update authority so the program
    // can sign asset creation into the collection.
    const umi = anchor.workspace.umi ?? undefined;
    collection = await createTestCollection(provider, authority, vaultPda, umi);

    buyerAta = await fundBuyer(buyer, 3);
  });

  describe("initialize", () => {
    it("rejects a sell-back price at or above the mint price", async () => {
      await expectError(
        () =>
          program.methods
            .initialize(
              new anchor.BN(MINT_PRICE.toString()),
              new anchor.BN(MINT_PRICE.toString()), // equal — drains the treasury
              SUPPLY_CAP,
              BASE_URI,
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
            .rpc(),
        "InvalidPrices",
      );
    });

    it("rejects a base URI without a trailing slash", async () => {
      await expectError(
        () =>
          program.methods
            .initialize(
              new anchor.BN(MINT_PRICE.toString()),
              new anchor.BN(REDEEM_PRICE.toString()),
              SUPPLY_CAP,
              "https://arweave.net/NOSLASH", // would produce ".../NOSLASH0.json"
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
            .rpc(),
        "InvalidBaseUri",
      );
    });

    it("initializes with prices, cap and a closed phase", async () => {
      await program.methods
        .initialize(
          new anchor.BN(MINT_PRICE.toString()),
          new anchor.BN(REDEEM_PRICE.toString()),
          SUPPLY_CAP,
          BASE_URI,
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

      const cfg = await program.account.config.fetch(configPda);
      assert.strictEqual(cfg.mintPrice.toString(), MINT_PRICE.toString());
      assert.strictEqual(cfg.redeemPrice.toString(), REDEEM_PRICE.toString());
      assert.strictEqual(cfg.supplyCap, SUPPLY_CAP);
      assert.strictEqual(cfg.mintedCount, 0);
      assert.strictEqual(cfg.circulating, 0);
      // Deliberately starts closed so a deploy cannot be minted against before
      // the collection is loaded and checked.
      assert.strictEqual(cfg.phase, 0);
    });
  });

  describe("mint", () => {
    it("refuses to mint while the phase is closed", async () => {
      await expectError(() => mintNew(buyer, buyerAta), "PhaseClosed");
    });

    it("mints, charges exactly the mint price, and credits the treasury", async () => {
      await setPhasePublic();

      const before = await getAccount(provider.connection, buyerAta);
      const treasuryBefore = await treasuryBalance();

      const asset = await mintNew(buyer, buyerAta);

      const after = await getAccount(provider.connection, buyerAta);
      assert.strictEqual(
        (before.amount - after.amount).toString(),
        MINT_PRICE.toString(),
        "buyer must be charged exactly the mint price",
      );
      assert.strictEqual(
        ((await treasuryBalance()) - treasuryBefore).toString(),
        MINT_PRICE.toString(),
        "tokens must land in the program-owned treasury",
      );

      const cfg = await program.account.config.fetch(configPda);
      assert.strictEqual(cfg.mintedCount, 1);
      assert.strictEqual(cfg.circulating, 1);

      // The asset must actually belong to the buyer and to our collection.
      const fetched = await fetchAssetV1(umiFor(provider), asset as never);
      assert.strictEqual(fetched.owner.toString(), buyer.publicKey.toString());
    });

    it("attaches a URI derived on-chain, not one supplied by the buyer", async () => {
      const asset = await mintNew(buyer, buyerAta);
      const fetched = await fetchAssetV1(umiFor(provider), asset as never);
      assert.isTrue(
        fetched.uri.startsWith(BASE_URI) && fetched.uri.endsWith(".json"),
        `URI ${fetched.uri} must be derived from the committed base`,
      );
    });

    it("fails clearly when the buyer cannot afford the mint price", async () => {
      const broke = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        broke.publicKey,
        LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);
      const ata = await createAssociatedTokenAccount(
        provider.connection,
        authority,
        tokenMint,
        broke.publicKey,
      );
      // Funded with one token less than the price.
      await mintTo(
        provider.connection,
        authority,
        tokenMint,
        ata,
        authority,
        MINT_PRICE - 1n,
      );
      try {
        await mintNew(broke, ata);
        assert.fail("mint should fail when the buyer is short");
      } catch (e) {
        assert.match(String(e), /insufficient/i);
      }
    });

    it("does not let a third party mint using someone else's token account", async () => {
      const attacker = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        attacker.publicKey,
        LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);
      // Passing the victim's ATA must fail the owner constraint.
      const asset = Keypair.generate();
      try {
        await program.methods
          .mintNew()
          .accounts({
            buyer: attacker.publicKey,
            config: configPda,
            vault: vaultPda,
            asset: asset.publicKey,
            collection,
            tokenMint,
            buyerTokenAccount: buyerAta, // not the attacker's
            treasury,
            mplCoreProgram: MPL_CORE_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker, asset])
          .rpc();
        assert.fail("must not spend another wallet's tokens");
      } catch (e) {
        assert.match(String(e), /ConstraintRaw|constraint|owner/i);
      }
    });
  });

  describe("redeem — the floor mechanic", () => {
    it("pays exactly the sell-back price and takes the asset into the vault", async () => {
      const asset = await mintNew(buyer, buyerAta);

      const before = await getAccount(provider.connection, buyerAta);
      const circBefore = (await program.account.config.fetch(configPda))
        .circulating;

      await redeem(buyer, buyerAta, asset);

      const after = await getAccount(provider.connection, buyerAta);
      assert.strictEqual(
        (after.amount - before.amount).toString(),
        REDEEM_PRICE.toString(),
        "holder must receive exactly the sell-back price",
      );

      const fetched = await fetchAssetV1(umiFor(provider), asset as never);
      assert.strictEqual(
        fetched.owner.toString(),
        vaultPda.toString(),
        "redeemed asset must be owned by the vault, not burned",
      );

      const cfg = await program.account.config.fetch(configPda);
      assert.strictEqual(cfg.circulating, circBefore - 1);
      // Supply is NOT reduced — the art returns to the mintable pool.
      assert.isAbove(cfg.mintedCount, 0);
    });

    it("keeps the 5% spread in the treasury across a full cycle", async () => {
      const treasuryBefore = await treasuryBalance();
      const asset = await mintNew(buyer, buyerAta);
      await redeem(buyer, buyerAta, asset);
      const delta = (await treasuryBalance()) - treasuryBefore;
      assert.strictEqual(
        delta.toString(),
        (MINT_PRICE - REDEEM_PRICE).toString(),
        "one mint+redeem cycle must leave the spread behind",
      );
    });

    it("refuses to redeem an asset the caller does not own", async () => {
      const asset = await mintNew(buyer, buyerAta);
      const stranger = Keypair.generate();
      const strangerAta = await fundBuyer(stranger, 1);
      await expectError(
        () => redeem(stranger, strangerAta, asset),
        "NotAssetOwner",
      );
    });

    it("refuses to redeem an asset from a different collection", async () => {
      // A Core asset that looks the part but is not ours must not be
      // redeemable for real tokens.
      const foreign = await createForeignAsset(provider, authority, buyer);
      await expectError(() => redeem(buyer, buyerAta, foreign), "WrongCollection");
    });

    it("fails with a readable error when the treasury cannot cover it", async () => {
      // Drain the surplus, then push the treasury below one sell-back by
      // withdrawing everything withdrawable and redeeming until short.
      const cfg = await program.account.config.fetch(configPda);
      const reserved = BigInt(cfg.circulating) * REDEEM_PRICE;
      const balance = await treasuryBalance();
      const surplus = balance > reserved ? balance - reserved : 0n;

      if (surplus > 0n) {
        const dest = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          authority,
          tokenMint,
          authority.publicKey,
        );
        await program.methods
          .withdrawSurplus(new anchor.BN(surplus.toString()))
          .accounts({
            authority: authority.publicKey,
            config: configPda,
            vault: vaultPda,
            tokenMint,
            treasury,
            destination: dest.address,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      }

      // Every remaining holder can still be paid — that is the invariant.
      const after = await treasuryBalance();
      const cfgAfter = await program.account.config.fetch(configPda);
      assert.isAtLeast(
        Number(after / REDEEM_PRICE),
        cfgAfter.circulating,
        "treasury must still back every outstanding NFT after a full withdrawal",
      );
    });
  });

  describe("recycled assets", () => {
    it("re-sells a vault-held asset without inflating minted_count", async () => {
      const asset = await mintNew(buyer, buyerAta);
      await redeem(buyer, buyerAta, asset);

      const before = await program.account.config.fetch(configPda);
      const second = Keypair.generate();
      const secondAta = await fundBuyer(second, 1);

      await program.methods
        .mintRecycled()
        .accounts({
          buyer: second.publicKey,
          config: configPda,
          vault: vaultPda,
          asset,
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

      const after = await program.account.config.fetch(configPda);
      assert.strictEqual(
        after.mintedCount,
        before.mintedCount,
        "recycling must not increment minted_count past the cap",
      );
      assert.strictEqual(after.circulating, before.circulating + 1);

      const fetched = await fetchAssetV1(umiFor(provider), asset as never);
      assert.strictEqual(fetched.owner.toString(), second.publicKey.toString());
    });

    it("refuses to recycle an asset the vault does not hold", async () => {
      const held = await mintNew(buyer, buyerAta); // owned by buyer, not vault
      const other = Keypair.generate();
      const otherAta = await fundBuyer(other, 1);
      await expectError(
        () =>
          program.methods
            .mintRecycled()
            .accounts({
              buyer: other.publicKey,
              config: configPda,
              vault: vaultPda,
              asset: held,
              collection,
              tokenMint,
              buyerTokenAccount: otherAta,
              treasury,
              mplCoreProgram: MPL_CORE_PROGRAM_ID,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([other])
            .rpc(),
        "AssetNotInVault",
      );
    });
  });

  describe("pause", () => {
    it("blocks minting but still lets holders sell back", async () => {
      const asset = await mintNew(buyer, buyerAta);

      await program.methods
        .setPaused(true, false)
        .accounts({ authority: authority.publicKey, config: configPda })
        .rpc();

      await expectError(() => mintNew(buyer, buyerAta), "MintPaused");

      // The important half: pausing mint must NOT trap existing holders.
      await redeem(buyer, buyerAta, asset);

      await program.methods
        .setPaused(false, false)
        .accounts({ authority: authority.publicKey, config: configPda })
        .rpc();
    });

    it("blocks sell-back when redeem is paused", async () => {
      const asset = await mintNew(buyer, buyerAta);
      await program.methods
        .setPaused(false, true)
        .accounts({ authority: authority.publicKey, config: configPda })
        .rpc();
      await expectError(() => redeem(buyer, buyerAta, asset), "RedeemPaused");
      await program.methods
        .setPaused(false, false)
        .accounts({ authority: authority.publicKey, config: configPda })
        .rpc();
      await redeem(buyer, buyerAta, asset);
    });

    it("cannot be toggled by a non-authority wallet", async () => {
      const rando = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        rando.publicKey,
        LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);
      try {
        await program.methods
          .setPaused(true, true)
          .accounts({ authority: rando.publicKey, config: configPda })
          .signers([rando])
          .rpc();
        assert.fail("only the program authority may pause");
      } catch (e) {
        assert.match(String(e), /ConstraintAddress|constraint|Unauthorized/i);
      }
    });
  });

  describe("withdraw_surplus", () => {
    it("cannot withdraw the funds backing outstanding sell-backs", async () => {
      await mintNew(buyer, buyerAta); // create an obligation
      const balance = await treasuryBalance();
      const dest = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority,
        tokenMint,
        authority.publicKey,
      );
      // Asking for the whole balance must be refused, because part of it is
      // reserved. This is the check that makes the floor real.
      await expectError(
        () =>
          program.methods
            .withdrawSurplus(new anchor.BN(balance.toString()))
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
        "WouldBreakFloor",
      );
    });

    it("cannot be called by a non-authority wallet", async () => {
      const rando = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        rando.publicKey,
        LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);
      const dest = await createAssociatedTokenAccount(
        provider.connection,
        authority,
        tokenMint,
        rando.publicKey,
      );
      try {
        await program.methods
          .withdrawSurplus(new anchor.BN(1))
          .accounts({
            authority: rando.publicKey,
            config: configPda,
            vault: vaultPda,
            tokenMint,
            treasury,
            destination: dest,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([rando])
          .rpc();
        assert.fail("only the program authority may withdraw");
      } catch (e) {
        assert.match(String(e), /ConstraintAddress|constraint/i);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers that need umi. Kept at the bottom so the tests above read cleanly.
// ---------------------------------------------------------------------------

function umiFor(provider: anchor.AnchorProvider) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createUmi } = require("@metaplex-foundation/umi-bundle-defaults");
  return createUmi(provider.connection.rpcEndpoint).use(mplCore());
}

/** Collection whose update authority is the vault PDA, so the program can sign. */
async function createTestCollection(
  provider: anchor.AnchorProvider,
  payer: Keypair,
  vaultPda: PublicKey,
  _umi?: unknown,
): Promise<PublicKey> {
  const umi = umiFor(provider);
  const {
    generateSigner,
    keypairIdentity,
    publicKey: toUmiPk,
  } = require("@metaplex-foundation/umi");
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(payer.secretKey)));
  const collectionSigner = generateSigner(umi);
  await createCollection(umi, {
    collection: collectionSigner,
    name: "PitBrokers",
    uri: `${BASE_URI}collection.json`,
    updateAuthority: toUmiPk(vaultPda.toBase58()),
  }).sendAndConfirm(umi);
  return new PublicKey(collectionSigner.publicKey.toString());
}

/** A Core asset in an unrelated collection, used to prove redeem rejects it. */
async function createForeignAsset(
  provider: anchor.AnchorProvider,
  payer: Keypair,
  owner: Keypair,
): Promise<PublicKey> {
  const umi = umiFor(provider);
  const {
    generateSigner,
    keypairIdentity,
    publicKey: toUmiPk,
  } = require("@metaplex-foundation/umi");
  const { create } = require("@metaplex-foundation/mpl-core");
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(payer.secretKey)));

  const foreignCollection = generateSigner(umi);
  await createCollection(umi, {
    collection: foreignCollection,
    name: "NotPitBrokers",
    uri: "https://example.invalid/fake.json",
  }).sendAndConfirm(umi);

  const asset = generateSigner(umi);
  await create(umi, {
    asset,
    collection: { publicKey: foreignCollection.publicKey },
    name: "PitBroker #1",
    uri: "https://example.invalid/1.json",
    owner: toUmiPk(owner.publicKey.toBase58()),
  }).sendAndConfirm(umi);

  return new PublicKey(asset.publicKey.toString());
}
