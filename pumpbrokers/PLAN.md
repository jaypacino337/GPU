# PumpBrokers — Milestone 1: Plan

Status: **awaiting your review.** No production code decisions are locked until you sign off on §7.

Everything below marked **[VERIFIED]** I looked up during this session and cite. Everything marked
**[ASSUMED]** is my judgement call that you can overturn cheaply. Everything marked **[BLOCKED]**
needs a value from you before that code path can run — and is wired to fail loudly, not silently.

---

## 1. Headline findings that change the spec

### 1.1 pump.fun creator fees — there IS a clean programmatic path (item C)

I pulled the live IDLs from `pump-fun/pump-public-docs` rather than guessing. **[VERIFIED]**

| Program | ID | Claim instruction |
|---|---|---|
| Pump (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | `collect_creator_fee`, `collect_creator_fee_v2` |
| Pump AMM (post-migration) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | `collect_coin_creator_fee` |

So: **real one-click on-chain claim, not a deep-link.** Three things you need to know:

1. **The vault seeds differ between the two programs, and it is a trap.**
   - Bonding curve: `["creator-vault", creator]` — **hyphen**
   - AMM: `["creator_vault", coin_creator]` — **underscore**

   These are not typos on my part; they are genuinely inconsistent upstream. Both are pinned in
   `config/pumpfun.ts` with a comment, because getting this wrong reads a non-existent account and
   silently shows a 0 balance.

2. **Fees accrue in two places depending on migration state.** Pre-migration, SOL accumulates as
   raw lamports in the bonding-curve `creator-vault` PDA (claimable amount = balance minus the
   rent-exempt minimum). Post-migration, they accrue as SPL quote tokens in the AMM vault's ATA.
   The admin page reads **both** and shows two claimable lines, because for a launched coin like
   $PUMPBROKER you may have balances in each.

3. **"Routing the proceeds to the treasury" cannot be atomic inside the claim.** `creator` is *not
   a signer* on `collect_creator_fee` — it is a permissionless crank whose only possible destination
   is the creator's own vault → creator wallet. You cannot redirect it to the treasury PDA in the
   same instruction.

   My design: **one transaction, two instructions** — `collect_creator_fee` followed by a
   transfer from your wallet to the treasury, both signed by your connected wallet. Atomic from
   your point of view, no server keypair, and if the second leg fails the first rolls back too.
   The UI states the two legs explicitly before you sign. **[ASSUMED]** — say the word if you'd
   rather claim to your wallet and move funds manually.

### 1.2 Don't pre-mint 1,000 NFTs — it wastes ~2.9 SOL

Spec milestone 3 says "load the 1,000 into the vault". I want to push back on that, because it is
the single largest avoidable cost in the project.

**[VERIFIED]** Metaplex Core is ~**0.0029 SOL** per asset vs ~**0.022 SOL** for Token Metadata
(single-account design, ~80% cheaper). Core is the right standard — confirmed.

But pre-minting 1,000 × 0.0029 = **~2.9 SOL of your money locked in rent before a single sale.**

Instead, **lazy mint**: the asset is created at purchase time, and the *buyer's* transaction pays
the ~0.0029 SOL rent for their own asset. Your upfront asset cost becomes **0 SOL**. The unminted
pool is a **1,000-bit bitmap (125 bytes)** in the config PDA, not 1,000 live accounts.

This costs you nothing in functionality — supply is still hard-capped at 1,000 by the bitmap, and
the art/metadata is still fully committed on Arweave up front, so nothing about what a buyer
receives is decided later.

### 1.3 Compressed NFTs (Bubblegum) — cheaper, but not worth it here

You asked me to sanity-check this. **[ASSUMED, reasoned]** A merkle tree sized for 1,024 leaves is
cheaper in absolute terms than 1,000 Core assets. But:

- With lazy minting, our upfront asset cost is already **0**, so cNFTs are competing against zero.
- Redemption requires **transfer-in to a program**. For cNFTs that means passing a DAS merkle proof
  into the instruction and CPI'ing Bubblegum — proof accounts eat transaction space, the tx can
  fail purely from a stale proof after someone else's transfer, and you now hard-depend on a DAS
  indexer being live *to be able to sell back at all*.
- Core assets are one account; the redeem CPI is a plain transfer with an owner check.

**Recommendation: Core, lazy-minted.** cNFTs would trade a cost we've already eliminated for
fragility in the one mechanic (sell-back) that must never break. Overrule me if you disagree.

### 1.4 The recycled-NFT pool needs no on-chain list

Redeemed assets become owned by the vault PDA. To re-mint one, the client passes a specific
vault-held asset and the program verifies (a) owner == vault PDA, (b) collection == ours. No
32KB on-chain array, no realloc. Two buyers racing for the same recycled asset → the loser's
tx fails the owner check and the client retries with a fresh mint. **[ASSUMED]**

---

## 2. Answers I'm proceeding on (overturn any of these)

| Question | Proceeding as | Basis |
|---|---|---|
| Mint price | `1_000_000` **tokens** (not USD) | Spec CONFIRM, your stated intent |
| "Nine fifty" | `950_000` tokens = 95% of mint | Spec: "my intent" |
| Redeemed NFTs | **Recycle** to mintable pool, not burned | Spec default; supply stays 1,000 |
| Spread | 5% (50,000 tokens/cycle) stays in treasury | Derived |
| Allowlist phase | **None in v1**; program has a `phase` field so it can be added without redeploy | **[ASSUMED]** |
| Airdrop recipient | Holder **at snapshot** — does not follow the NFT on resale | **[ASSUMED]** |
| Payout asset | Per-ticker switch, defaults to the xStock | Spec |
| Network | devnet only until you say otherwise | Spec |

**[BLOCKED] — cannot run without these:**

1. `$PUMPBROKER` mint address **and decimals**. Decimals matter more than they look: with 6
   decimals the mint price is `1_000_000_000_000` base units. Wrong decimals = off by 1000×.
2. Admin / program-authority wallet pubkey.
3. The 9 unverified xStock mint addresses (only `GMEx` = `Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc` is known).

Placeholders are the literal string `"SET_ME"`. Config validation throws at import, and the
airdrop tool refuses any ticker still unset — that is the spec'd behaviour, not a stub.

---

## 3. Stack

| Layer | Choice | Cost |
|---|---|---|
| Frontend | Next.js 15 App Router + TS + Tailwind | Vercel Hobby — **$0** |
| Wallet | `@solana/wallet-adapter` (Phantom, Solflare, Backpack) | $0 |
| On-chain | one Anchor program, `mint` / `redeem` / `pause` | rent only, see §5 |
| NFT | Metaplex Core (`mpl-core`), lazy-minted | buyer pays own rent |
| Storage | Arweave via Irys, one-time upload | see §5 |
| RPC | Helius free tier, key server-side only | **$0** |
| Indexing | none — DAS `getAssetsByGroup` / `getAssetsByOwner` | **$0** |
| Analytics | skipped | $0 |
| **Monthly total** | | **$0** |

No database. Holder snapshots read from chain, per spec. The airdrop's idempotency ledger is the
one thing that *wants* persistence — I'm using a committed JSON file written by the admin script
plus on-chain signature verification as the source of truth, so a re-run reconciles against the
chain rather than trusting a cache. If that proves too clumsy in practice I'll come back and make
the case for a DB rather than sneaking one in.

---

## 4. Program account layout

```
Config PDA — seeds ["config"]
  authority          Pubkey    32   admin, only key that can pause/update
  token_mint         Pubkey    32   $PUMPBROKER
  collection         Pubkey    32   Core collection
  treasury           Pubkey    32   vault-owned token account
  mint_price         u64        8   base units, integer
  redeem_price       u64        8   base units, integer
  supply_cap         u16        2   1000
  minted_count       u16        2   assets ever created (monotonic, != circulating)
  circulating        u16        2   held by users; -1 on redeem, +1 on mint
  paused_mint        bool       1
  paused_redeem      bool       1
  phase              u8         1   0=closed 1=allowlist 2=public
  vault_bump         u8         1
  bitmap             [u8;125] 125   1000 bits: 1 = index already created
```

```
Vault authority PDA — seeds ["vault"]
  no data. Owns the treasury token account and every recycled Core asset.
```

### Instructions

| ix | Signer | Guards |
|---|---|---|
| `initialize` | authority | once; prices from `config/` |
| `mint_new` | buyer | `!paused_mint`, `minted_count < cap`, pulls `mint_price`, marks bitmap, creates Core asset |
| `mint_recycled` | buyer | `!paused_mint`, asset owned by vault + in collection, pulls `mint_price`, transfers out |
| `redeem` | holder | `!paused_redeem`, asset in collection, **`treasury >= redeem_price`**, transfers asset in, pays out |
| `set_paused` | authority | independent mint/redeem flags |
| `set_phase` | authority | |
| `withdraw_surplus` | authority | **cannot** touch `circulating * redeem_price` — the floor is structurally protected |

### The invariant

`treasury_balance >= circulating * redeem_price` is the promise the floor mechanic makes. Every
mint adds 1,000,000 and creates one redemption obligation of 950,000 — net **+50,000 headroom per
mint**, so the invariant strengthens monotonically under normal operation. Two places could break
it, and both are closed:

- `redeem` asserts `treasury >= redeem_price` before paying and errors with
  `InsufficientTreasury` (a readable error, per spec) — never an arithmetic underflow.
- `withdraw_surplus` is capped at `treasury - circulating * redeem_price`. **The admin cannot
  withdraw the money that backs outstanding redemptions.** This is the one line that makes the
  floor real rather than a promise, and it is worth you specifically reviewing.

All amounts `u64` with `checked_*` arithmetic. No floats anywhere near amounts — `f64` is banned
in the program and amounts are `bigint`/string end-to-end in the frontend.

### Randomness — an honest limitation

"One random unminted PumpBroker" cannot be truly random on-chain. I pick from the bitmap using
`SlotHashes` + buyer pubkey + `minted_count`. A sophisticated actor who can simulate and choose
when to land a transaction can bias which index they get. Mitigating this properly needs a
commit-reveal (two transactions, worse UX) or a VRF (paid infra, against the cheap mandate).

Given the rarity distribution is public and every piece has the same 950,000 floor, I judge the
grinding incentive low — but it is a real weakness and it goes in the §7 security self-review
rather than getting buried. Tell me if you want commit-reveal instead.

---

## 5. Costs

**Devnet: free** (airdropped SOL). Mainnet, one-time:

| Item | SOL | Note |
|---|---|---|
| Program deploy | ~2.0–3.0 | scales with binary size; **recoverable** by closing the program |
| Config PDA (~250 B) | ~0.0025 | |
| Vault treasury token account | 0.00204 | fixed |
| Core collection | ~0.003 | |
| 1,000 Core assets | **0** | lazy — buyer pays ~0.0029 each |
| Arweave upload (~50 MB) | see below | one-time |
| **You pay** | **~2.01–3.01** | dominated by program rent |

Arweave: 1,000 pixel PNGs + 1,000 JSON is a small payload, but I am **not** going to quote you a
dollar figure I haven't measured. `scripts/estimate-upload.ts` prints Irys's live quote for the
actual bytes and **exits without uploading** until you pass `--confirm`. You will see the real
number before anything is spent. **[VERIFIED that this is the right shape; amount unmeasured.]**

Per-user mint cost: ~0.0029 SOL rent + ~0.000005 fee, plus the 1,000,000 $PUMPBROKER.

---

## 6. Build order

| # | Milestone | State |
|---|---|---|
| 1 | **Plan** | ← you are here |
| 2 | Program + Anchor tests, devnet | code written, see §8 |
| 3 | Arweave upload, Core collection, bitmap init | script + dry-run gate |
| 4 | Landing / Mint / My Brokers / sell-back | |
| 5 | Gallery + docs | |
| 6 | Admin: fee collect + airdrop | |
| 7 | Hardening + security self-review | |
| 8 | Mainnet checklist with per-step SOL | |

## 7. What I need from you to unblock

1. Token **mint address + decimals** ← hard blocker for any devnet run
2. Admin wallet pubkey
3. §1.2 lazy-mint instead of pre-loading the vault — **yes/no**
4. §1.1 two-instruction fee claim — **yes/no**
5. §4 randomness: slot-hash pick vs commit-reveal
6. Allowlist phase for StonkBrokers holders — needed, or leave the `phase` field dormant?

## 8. Toolchain limitation in this environment — read this

I have Rust and Node, but this container's egress proxy **blocks the Anza release host and the
Anchor toolchain download**. Concretely:

- ✅ I can write the program and **`cargo check` it** (real type/borrow verification)
- ✅ I can install npm deps and typecheck the frontend
- ❌ I **cannot** run `anchor build`, `anchor test`, or deploy to devnet from here

So "deployed to devnet and tested" in milestone 2 is **not** something I can truthfully claim from
this session. What I deliver is the program, the tests, and `scripts/devnet-e2e.ts`, all runnable
with one command on a machine that has the Anchor toolchain. I will tell you exactly which parts
I executed and which I only wrote — I won't report green tests I never ran.

---

### Sources

- [Metaplex Core vs Token Metadata](https://www.metaplex.com/docs/smart-contracts/core/tm-differences)
- [Creating Core Assets](https://www.metaplex.com/docs/smart-contracts/core/create-asset)
- [pump.fun public docs + IDLs](https://github.com/pump-fun/pump-public-docs/tree/main/idl) — `pump.json`, `pump_amm.json` read directly
