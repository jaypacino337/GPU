# PitBrokers

Solana dApp for a 1,000-piece pixel-art NFT collection with a token-denominated
mint and a program-enforced price floor.

- **Mint** — 1,000,000 $PUMPBROKER → one random unminted PitBroker
- **Sell back** — return any PitBroker → 950,000 $PUMPBROKER (95%, the floor)
- The 5% spread stays in a program-owned treasury, so the system self-funds
- Redeemed pieces return to the mintable pool; supply stays at 1,000

Read **[PLAN.md](./PLAN.md)** first — cost table, account layout, design
decisions with reasoning, open questions. Then **[SECURITY.md](./SECURITY.md)**
for what could go wrong, and **[MAINNET_CHECKLIST.md](./MAINNET_CHECKLIST.md)**
for the launch sequence with per-step SOL costs.

> **Status in one line:** the code is written and compile-verified; **nothing has
> been deployed or exercised on any chain**. See *What was actually executed*
> below before trusting any of it.

## Current state

| Milestone | Status |
|---|---|
| 1. Plan | ✅ [PLAN.md](./PLAN.md) |
| 2. Program + tests | ✅ written, ⚠️ **not deployed** — see *Toolchain* below |
| 3. Assets → Arweave, Core collection | ✅ scripts written + guards tested; needs real assets |
| 4. Frontend core | ✅ builds and serves; needs real config to talk to chain |
| 5. Gallery + docs | ✅ |
| 6. Admin: fee collect + airdrop | ✅ execution implemented; unexercised on chain |
| 7. Hardening + security review | ✅ [SECURITY.md](./SECURITY.md) |
| 8. Mainnet checklist | ✅ [MAINNET_CHECKLIST.md](./MAINNET_CHECKLIST.md) |

### What was actually executed vs only written

Being precise about this, because "tests pass" should mean something:

- ✅ **Executed** — `cargo check` on the program (clean) and **17 Rust unit
  tests, all passing** (`npm run test:unit`). They cover the 1,000-bit supply
  bitmap, index selection, the floor/reserve arithmetic, the mint→redeem cycle
  invariant, and a guard that `Config::LEN` matches the serialized layout.
- ✅ **Executed** — `tsc --strict` on `config/` (clean), `tsc --noEmit` on the web
  app (clean), `next build` (all 10 routes prerender), and a smoke test against
  `next start`: pages render, and the RPC proxy correctly returns 405 on GET,
  403 for a non-allowlisted method, and 503 when no upstream is configured.
- ⚠️ **Written but not executed** — `tests/pitbrokers.ts` (Anchor integration
  tests) and `scripts/devnet-e2e.ts`. This container's egress proxy blocks the
  Anza release host and the Anchor toolchain download, so `anchor build`,
  `anchor test` and devnet deploy could not run here. Both are ready to run on a
  machine with the toolchain.

## Layout

```
config/            single source of truth — every price, address, supply number
  index.ts         token, prices, PDA seeds, validation
  pumpfun.ts       pump.fun program IDs + creator-vault seeds (from the live IDLs)
  tickers.ts       the 10 xStock tickers and the per-ticker payout switch
programs/pitbrokers/
  src/lib.rs       instructions: initialize, mint_new, mint_recycled, redeem,
                   set_paused, set_phase, withdraw_surplus
  src/state.rs     Config account, supply bitmap, floor math (+ unit tests)
  src/errors.rs    user-facing error messages
web/               Next.js App Router frontend
  app/             landing, mint, my-brokers, gallery, airdrop, admin, docs
  app/api/rpc/     server-side RPC proxy — the Helius key lives here only
  lib/             integer-only formatting, DAS reads, instruction builders,
                   simulate-then-send, airdrop preflight gates
tests/             Anchor integration tests
scripts/
  upload-assets.ts     Irys quote; refuses to spend without --confirm
  create-collection.ts Core collection, update authority = vault PDA (verified)
  compute-rarity.ts    writes web/public/rarity.json
  devnet-e2e.ts        full lifecycle, asserts the invariant at every step
```

## Running what exists

```bash
# Frontend
cd web && cp .env.example .env.local   # fill in the SET_ME values
npm install && npm run dev

# Unit tests — these work anywhere Rust does
npm run test:unit          # cargo test -p pitbrokers --lib

# Needs the Anchor toolchain (not available in the authoring container)
anchor build
anchor keys sync           # replaces the placeholder program ID
anchor test                # spins a validator with Metaplex Core cloned

# Full lifecycle on devnet
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
COLLECTION=<core collection> BASE_URI=https://arweave.net/<manifest>/ \
npm run e2e:devnet
```

## The invariant

The floor is only as good as the guarantee behind it:

```
treasury_balance >= circulating * redeem_price
```

Every mint adds 1,000,000 and creates one 950,000 obligation, so each mint adds
50,000 of headroom — the invariant strengthens on its own. Two things could
break it, and both are closed in the program:

1. `redeem` asserts `treasury >= redeem_price` and fails with a readable
   `InsufficientTreasury` rather than underflowing. The site shows
   *"redemptions currently available: N"* from the same figure.
2. `withdraw_surplus` is capped at `treasury - circulating * redeem_price`.
   **The admin cannot withdraw the funds backing outstanding sell-backs**, so
   the floor does not depend on the admin behaving well.

## Blocked on

1. **$PUMPBROKER mint address and decimals.** Decimals are load-bearing — with 6
   decimals the mint price is `1_000_000_000_000` base units. A wrong value is
   off by a power of ten, so it is validated rather than defaulted.
2. **Admin / program-authority wallet.**
3. **9 of the 10 xStock mint addresses.** Only `GMEx` is verified. The airdrop
   tool refuses to run for any unset ticker — by design, not as a stub.

Unset values are the literal string `SET_ME`; `assertConfigReady()` throws on
them before anything can build a transaction.

## Security notes

- No private keys in the frontend, ever. Admin actions are signed by the
  connected wallet — there is no server keypair anywhere in the design.
- Metadata URIs are derived **on-chain** from a committed base URI. The caller
  cannot supply one, so a buyer cannot mint an asset pointing at art of their
  choosing.
- Redemption only accepts assets whose Core update authority **is our
  collection**. Anyone can create an asset named "PitBroker #7"; only ours are
  redeemable for real tokens.
- Emergency pause is independent for mint and redeem — pausing mint without
  pausing redeem is the right response to most incidents, since it stops new
  obligations without trapping existing holders.
- **Known weakness:** index selection uses slot/clock-derived entropy, which a
  sophisticated actor who can simulate and time a transaction can bias. It is
  documented in PLAN.md §4 rather than buried; commit-reveal is the fix if we
  decide the grinding incentive is real.
