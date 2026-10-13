# Decision for Jay: a real-SOL version of compute epochs?

**Status: not built, not live.** The shipped game uses free power (⚡) that
can't be bought, sold or withdrawn. Rewards come only from $CSTR trading fees.
This doc covers what letting players **deploy real SOL** (exactly like ORE)
would take. Nothing here should ship without your explicit go-ahead.

## What changes

| | free version (now) | real-SOL version |
|---|---|---|
| Stake | free ⚡, server-held | SOL, held by an **on-chain program** (escrow PDA), never by our server |
| Randomness | hash-chain commit + drand, checked off-chain | **on-chain VRF**: ORAO VRF or Switchboard On-Demand randomness, or ORE's own Entropy program. The draw must be verifiable by the program itself, not by a web page. |
| Settlement | our Node server | the program: `deploy` → `reset`/settle → `claim`, permissionless cranks like ORE's `reset`/`checkpoint` |
| Payout of losers' SOL | n/a | 90% to the winning rack pro-rata; 10% protocol cut → **buyback + burn $CSTR** (ORE: 10% vaulted for buybacks plus a 1% admin fee) |
| CHIP / motherlode | season points | could become real $CSTR emissions, which needs a mint authority or a funded emissions vault |
| Anti-sybil | presence-gated power, flags | mostly solved by the economics: every deploy costs real SOL |

## What it would take

1. **Program.** An Anchor (or Steel, like ORE) program with a board account,
   per-round accounts, a per-miner account, and deploy, settle and claim
   instructions with VRF integration. Rough size: 2–4 weeks for one experienced
   Solana dev, plus tests on a local validator and devnet.
2. **Audit.** It custodies user funds, so an external audit is needed before
   mainnet ($15k–$60k+, 2–6 weeks), plus a bug bounty.
3. **Front end.** Phantom signs real transactions (the wallet-link code is
   already there). Show fees and odds clearly, and add a deposit-limit UI.
4. **Ops.** Crank bots for settlement, an RPC provider, monitoring, and an
   emergency pause with a public policy.

## Legal check (flagged before; still the blocker)

Staking money on a random draw for a chance at others' stakes is
**gambling** in most places, however it's framed ("mining", "deploying").
Before building:

- Get counsel on gambling and gaming licensing in your jurisdiction and your
  target markets. Many require a licence; some ban it outright, including
  several US states.
- Get counsel on whether fee-funded payouts, burns and emissions make $CSTR or
  the game a **security** or a **regulated product** (the flywheel note in the
  memcoinz skills raised this already).
- Expect geofencing, age gating, KYC (depending on the licence), terms of
  service, responsible-gaming limits, and tax reporting.
- ORE operating doesn't mean it's safe for you. Different entity, different
  jurisdiction, different risk.

The free-to-play version was designed to stay clear of this: no purchase, no
stake, no cash-out of in-game units. Rewards are discretionary, funded by
trading fees, and go to the season's top miners. Even so, get a sweepstakes /
promotional-game review before marketing it widely.

## Recommendation

Keep the free version live for a few seasons to prove demand and the fee flow.
Commission the legal review in parallel. Only if counsel clears a structure,
build the program with an on-chain VRF on devnet, audit it, and launch behind a
geofence. Decide again after the legal answer, not before.
