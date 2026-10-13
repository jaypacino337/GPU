# Provably fair compute epochs

CSTR's draw is an off-chain port of ORE's own randomness design. ORE
([regolith-labs/ore](https://github.com/regolith-labs/ore), `reset.rs`) samples
its **Entropy** program: a hash-chain commit-reveal by the provider, mixed with
a Solana slot hash from after the round. CSTR does the same, but uses the
**drand** beacon in place of the slot hash.

## The scheme (`lib/fairness.js`)

1. **Commit (once).** On first boot the server draws a secret `x0` (stored only
   in `DATA_DIR/seed-secret.json`, mode 0600, never served) and computes
   `x_N = sha256^N(x0)` with `N = 2^20`, about 2 years of 60-second epochs.
   `x_N` is the **anchor**, published at `/api/config` → `fairness.chain`.
2. **Per epoch.** Epoch `e` is link `j = e − genesisEpoch + 1` and uses
   `seed_e = x_(N−j)`. Its **commit** is `sha256(seed_e)`, which is also the
   previous epoch's seed, so it is public before the epoch opens (`/api/board`
   → `epoch.commit`). The server is locked into every future seed from the
   moment the anchor is published.
3. **Sample.** When the epoch closes at `endsAt`, the server waits for the
   first **drand quicknet** round published strictly after `endsAt`:
   `round = floor((endsAt/1000 − genesis)/3) + 2`. It fetches the round and
   **verifies its BLS signature** against the League of Entropy public key
   (`@noble/curves`). A bad signature is never used.
4. **Value.** `value = sha256("CSTR-epoch:" + e ‖ seed_e ‖ sha256(signature))`.
5. **Outcome** (`public/rules.js` `outcome()`), read from `value` as four
   big-endian u64 words:
   - `w0 mod 25` → winning rack (A1..E5), same as ORE's `rng % 25`
   - `w1` even → the +1 CHIP is split pro-rata; odd → one top miner (ORE's 50/50 split)
   - `w2 mod power-on-rack` → top-miner sample, walked through deploys in order
   - `w3 mod 500 == 0` → motherlode hit (ORE's current program uses 1/500)
6. **Reveal.** The settled epoch at `/api/epochs/:e` publishes `seed`, `commit`,
   the drand `round`, `signature` and `randomness`, `value`, the per-rack totals
   and the winning rack's deploy order (`winOrder`, by public tag).

## Why nobody can steer it

| party | could it pick the result? |
|---|---|
| Server | No. The seed was fixed when the anchor was published, and the drand round doesn't exist until after deploys close. Its only lever is to not settle, and a stuck epoch is **void after 5 minutes with every deploy refunded**. The house never deploys. |
| drand | No. It never sees the seed, and its rounds are a threshold BLS signature from the League of Entropy network. |
| Players | No. Deploys close at `endsAt`; the value depends on a later drand round. |

Rack totals are visible while an epoch is open. ORE works the same way, and
reading the board is part of the strategy.

## How to check an epoch

- **Browser:** `/rewards#fairness` → **Verify**. It fetches the round from
  `api.drand.sh` directly (CSP `connect-src` allows it), checks the seed against
  its commit, and recomputes the value and outcome with WebCrypto.
- **Full check, including BLS:** `npm run verify-epoch -- https://<site> <epoch>`
  verifies seed → commit, seed → anchor, drand's BLS signature (fetched from
  drand), round timing, value, rack, split and motherlode roll.

## Operations

- `seed-secret.json` lives on the Railway volume. **Back it up privately.** If
  it leaks, players could predict *seeds*, but still not outcomes, because
  drand rounds are unknown until after close. Rotate anyway: delete it and
  restart. A new chain with a new anchor starts from the next epoch.
- If drand is unreachable, epochs void (refund) and the `/healthz` `pending`
  count rises. Nothing else breaks.
- Verified 2026-10-13: a real settlement on a running server against live
  quicknet, plus `verify-epoch` passing 9/9 checks and the browser **Verify** passing.
