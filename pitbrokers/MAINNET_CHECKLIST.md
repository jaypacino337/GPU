# Mainnet checklist

Milestone 8. Every step in order, with what it costs in SOL.

**Do not start this until devnet has run end to end.** Steps 1–8 are devnet and
cost nothing; the SOL column applies only from step 12 onward.

SOL figures are estimates from the account sizes in `PLAN.md §5`. Where a number
depends on something not yet measured (program binary size, Arweave payload) the
step tells you how to get the real figure before spending.

---

## Phase A — devnet, free

| # | Step | Command | Cost |
|---|---|---|---|
| 1 | Install the Anchor toolchain | `avm install 0.31.1 && avm use 0.31.1` | free |
| 2 | Generate the program keypair and sync the ID | `anchor keys sync` | free |
| 3 | Build | `anchor build` | free |
| 4 | **Run the integration tests** | `anchor test` | free |
| 5 | Fund a devnet wallet | `solana airdrop 5 --url devnet` | free |
| 6 | Deploy to devnet | `anchor deploy --provider.cluster devnet` | free |
| 7 | Create the Core collection with the **vault PDA** as update authority | `ts-node scripts/create-collection.ts` | free |
| 8 | Run the full lifecycle | `npm run e2e:devnet` | free |

**Gate: do not proceed until step 4 and step 8 both pass.** Step 4 is the first
time any mpl-core CPI is exercised — see `SECURITY.md §5.1`.

---

## Phase B — decisions, free but blocking

| # | Step |
|---|---|
| 9 | **Decide the randomness question** (`SECURITY.md §3`). Recommendation: commit-reveal, because of the airdrop pieces. Changing this after launch means a new program. |
| 10 | **Decide the upgrade-authority policy** (`SECURITY.md §6`): single key, multisig, or burn. |
| 11 | **Get an independent review.** My self-review is not a substitute. |

---

## Phase C — mainnet spend

| # | Step | Cost (SOL) | Notes |
|---|---|---|---|
| 12 | Measure the Arweave upload | 0 | `npm run estimate:upload` prints the live Irys quote and **exits without uploading**. Read the number before continuing. |
| 13 | Upload 1,000 images + metadata to Arweave | *see step 12* | One-time. Pixel PNGs compress well; expect a small payload. Record the manifest ID. |
| 14 | Verify a random sample of 10 uploaded URIs resolve | 0 | `<manifest>/0.json` … `<manifest>/999.json`. A bad base URI bakes into `initialize`. |
| 15 | Fund the deploy wallet | — | Load ~4 SOL to cover steps 16–19 with headroom. |
| 16 | Deploy the program | **~2.0–3.0** | Scales with binary size. `solana program show <id>` reports the exact rent. **Recoverable** by closing the program. |
| 17 | Create the Core collection (update authority = vault PDA) | **~0.003** | Getting the authority wrong means `mint_new` can never sign. Verify before continuing. |
| 18 | Create the treasury token account, owner = vault PDA | **0.00204** | Must be off-curve-allowed; it is a PDA. |
| 19 | `initialize` with real prices, cap 1000, and the Arweave base URI | **~0.0025** | Base URI **must** end in `/`. Prices in base units — check the decimals one more time. |
| 20 | Verify config on-chain matches `config/` | 0 | Read it back and compare every field. |
| | **Subtotal** | **~2.01–3.01** | Plus the Arweave figure from step 12. |

---

## Phase D — go live

| # | Step | Cost |
|---|---|---|
| 21 | Set frontend env: `NEXT_PUBLIC_CLUSTER=mainnet-beta`, real mint, decimals, program ID, collection, admin wallet | 0 |
| 22 | Set `HELIUS_RPC_URL` to a **mainnet** key, server-side only | 0 |
| 23 | Deploy to Vercel; confirm the config banner is **gone** | 0 |
| 24 | Confirm the browser never sees the Helius key — check the network tab; all RPC goes to `/api/rpc` | 0 |
| 25 | Seed the treasury so sell-back works from mint #1 | your call | Without seeding, the first redeem needs a prior mint. Seeding ~10 × 950,000 makes the floor real immediately. |
| 26 | **Mint one broker yourself and sell it back** | ~1,000,000 tokens + ~0.003 | The real end-to-end test. Confirm you receive exactly 950,000 back. |
| 27 | Open the phase: `set_phase(2)` | ~0.000005 | This is the launch moment. |
| 28 | Watch the first ten mints | 0 | Confirm `minted_count` increments and the treasury grows by 1,000,000 each time. |

---

## Phase E — after launch

| # | Step |
|---|---|
| 29 | Verify the airdrop tickers' mints on mainnet and set them in `config/tickers.ts`. The tool refuses unset tickers by design. |
| 30 | Fund the treasury with the xStock (or USDC) amounts before any snapshot. |
| 31 | Run one airdrop with a **single ticker and a small holder set** first. |
| 32 | Publish the distribution record to the airdrop page. |
| 33 | Claim creator fees once the flow has been exercised on devnet (`SECURITY.md §5.4`). |

---

## Rollback

| Situation | Action |
|---|---|
| Bug found in minting | `set_paused(true, false)` — stops new mints, **leaves sell-back open** so holders are never trapped. |
| Bug found in sell-back | `set_paused(true, true)`, then communicate immediately. Pausing sell-back suspends the floor; treat it as a last resort. |
| Treasury short | Send tokens directly to the treasury token account. No instruction needed. |
| Program must be replaced | Only if the upgrade authority still exists (step 10). |

---

## Numbers to re-check before you spend

Everything below was estimated, not measured, and should be confirmed:

- **Program deploy rent (step 16)** — depends on the compiled binary. Get the
  real figure from `anchor build` + `solana program show`.
- **Arweave upload (step 13)** — step 12 prints the live quote.
- **Per-asset rent (~0.0029)** — from Metaplex's current docs. Confirm on devnet
  by diffing a buyer's SOL balance across one mint.
