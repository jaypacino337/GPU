# PitBrokers — security self-review

Milestone 7. This is a written self-review of what could go wrong, not an audit.
I wrote the code being reviewed here, which is the weakest possible position from
which to review it — treat this as a map of where to look, not as assurance.

Severity is my judgement of impact × likelihood **if the issue were live on
mainnet**. Items marked ⚠️ are unresolved and need your decision.

---

## 1. Things that would lose user funds

### 1.1 Treasury insolvency — **closed, and it is the core guarantee**

The floor is a promise to pay `redeem_price` for any outstanding NFT. It breaks
if the treasury is ever short. Three paths in, all closed:

| Path | Guard |
|---|---|
| Redeeming when treasury < payout | `require!(treasury.amount >= redeem_price)` → `InsufficientTreasury`, before any transfer |
| Admin withdrawing the backing | `withdraw_surplus` capped at `treasury − circulating × redeem_price` |
| Arithmetic wrapping to a huge balance | `checked_mul` / `checked_sub` everywhere; `overflow-checks = true` in release |

The invariant `treasury >= circulating × redeem_price` strengthens on its own:
each mint adds `+1,000,000` and one `950,000` obligation, netting `+50,000`.

`withdraw_surplus`'s cap is the single most important line in the program. If a
future change loosens it, the floor becomes a promise again. **Unit-tested**
(`withdrawable_surplus_never_eats_the_floor`) and integration-tested
(`cannot withdraw the funds backing outstanding sell-backs`).

### 1.2 Redeeming a counterfeit NFT — **closed**

Anyone can create a Core asset named `PitBroker #7` with our exact artwork URI.
If `redeem` accepted it, the treasury would pay 950,000 real tokens for a
worthless asset — a direct drain, repeatable until empty.

`require_collection()` accepts an asset **only** if its Core update authority
*is* our collection pubkey. Name and URI are never trusted. Integration test:
*"refuses to redeem an asset from a different collection"*.

### 1.3 Forged metadata at mint time — **closed by design**

An earlier draft passed `name`/`uri` as instruction arguments. That would let a
buyer mint a legitimate, in-collection asset pointing at metadata of their
choosing — e.g. claiming a rare trait or a fake `Airdrop: GMEx` attribute,
turning a 1,000,000-token mint into an airdrop claim.

URIs are now **derived on-chain** from a `base_uri` committed at `initialize`:
`<base><index>.json`. The caller cannot influence it. `initialize` also rejects a
base without a trailing slash, which would otherwise silently produce
`.../MANIFEST0.json`.

### 1.4 Spending someone else's tokens — **closed**

`buyer_token_account.owner == buyer.key()` is an account constraint, and the
buyer signs the transfer. Integration test: *"does not let a third party mint
using someone else's token account"*.

---

## 2. Things that would break the mechanic

### 2.1 Supply inflation via redeem/mint cycling — **closed**

`minted_count` is monotonic and never decremented; `mint_recycled` deliberately
does not touch it. If it did, an attacker could mint → redeem → mint repeatedly
and create assets past index 999. `circulating` tracks live obligations
separately. Integration test: *"re-sells a vault-held asset without inflating
minted_count"*.

### 2.2 Two buyers racing for the last NFT — **closed by construction**

Both land in the same block; both pass the client-side check. On-chain,
`mark_minted` rejects an already-set bit and `minted_count < supply_cap` is
re-checked inside the instruction. The loser gets `SoldOut` or
`IndexAlreadyMinted` — a clear error, not a double-mint.

### 2.3 Two buyers racing for the same recycled asset — **closed by construction**

`mint_recycled` requires `asset.owner == vault`. Once the first transfer lands,
the second fails `AssetNotInVault`. The frontend surfaces this as *"Someone else
claimed that broker first. Try again."* and can retry with `mint_new`.

### 2.4 Redeem racing a mint for treasury balance — **closed**

Solana serialises writes to the same accounts. Both touch the treasury, so they
cannot interleave. The solvency check and the payout are in the same instruction.

### 2.5 Wallet disconnect mid-transaction — **handled**

`simulateThenSend` distinguishes user rejection ("You cancelled the
transaction.") from a disconnect, and states explicitly that nothing was sent.
A disconnect after signing but before confirmation is the genuinely ambiguous
case: the transaction may still land. The UI does not currently poll for this.
**Gap — see §5.2.**

---

## 3. ⚠️ Unresolved: mint randomness is grindable

`entropy_seed()` hashes `(buyer, clock.slot, clock.unix_timestamp,
minted_count)`. All four are knowable or influenceable at simulation time.

**The attack:** simulate a mint, see which index you would receive, and only
submit when it is a rare one. Repeat across many payer keypairs. The realistic
outcome is an attacker skewing their holdings toward rare traits.

**Why I judged it acceptable:** every piece has the same 950,000 floor, so
grinding buys aesthetic rarity, not economic advantage. The cost is a real
1,000,000-token mint each time.

**Why it might not be:** if secondary-market prices diverge sharply by rarity, or
if the `Airdrop` pieces are worth materially more than a normal piece, the
incentive becomes concrete. **The 100 airdrop pieces are exactly the case where
this stops being cosmetic** — grinding for a `GMEx` piece has a directly
computable payoff.

**Options, in increasing cost:**

1. **Accept it** and say so publicly (the docs page already does).
2. **Commit-reveal** — buyer commits a hash, a second transaction reveals.
   Removes the grind entirely. Costs a second transaction and worse UX.
3. **Sequential assignment** — hand out index `minted_count` in order. No
   randomness to grind, but the mint order becomes fully predictable.
4. **VRF** — costs money and infrastructure, against the cheap mandate.

**My recommendation: option 2, specifically because of the airdrop pieces.** If
the airdrop is dropped or made non-transferable, option 1 becomes defensible.
**This needs your decision before mainnet.**

---

## 4. Frontend and infrastructure

| Item | State |
|---|---|
| Private keys in frontend | None. No server keypair exists anywhere in the design. |
| Helius key exposure | Server-only via `/api/rpc`; `serverRpcUrl()` throws if called in a browser. |
| Open RPC proxy | Methods **allowlisted**, batch ≤ 10, body ≤ 100 KB, 20s timeout. |
| Rate limiting | 120 req/min per IP, in-memory. |
| Admin gating | Gated on the **on-chain** authority, not the env var. Cosmetic only — the program enforces it. |
| Float contamination | All amounts `bigint`; fractions truncate, never round. |
| XSS | No `dangerouslySetInnerHTML`. Metadata strings render as text. |
| Clickjacking | `X-Frame-Options: DENY`. |

### 4.1 Rate limiting is per-instance — accepted

On serverless, each instance keeps its own counter, so the real limit is
`instances × 120`. It defends the free-tier RPC quota against casual abuse,
which is all it is for. Every state change still costs a signed transaction.

### 4.2 ⚠️ Metadata images are not integrity-checked

The frontend renders whatever `uri` the asset carries. Since URIs are derived
on-chain from our committed base (§1.3), an in-collection asset always points at
Arweave. Arweave content is immutable, so this is low risk — but the app does not
verify a hash. Accepted.

---

## 5. Known gaps — work not yet done

### 5.1 **Nothing has been verified on-chain.** ← the big one

`anchor build`, `anchor test` and devnet deploy have never run. The Anchor
integration tests are written but unexecuted. Every "closed" above rests on
`cargo check`, 17 unit tests of pure logic, and reading the code.

**Specifically unverified:** every mpl-core CPI. The `CreateV2`/`TransferV1`
builder calls, whether the vault PDA correctly signs as collection update
authority, and whether `BaseAssetV1` deserialises as expected against a real Core
account. These are the highest-risk unverified surface in the project.

### 5.2 Confirmation timeout after signing

If a wallet disconnects between signing and confirmation, the UI reports failure
while the transaction may still land. A user could conclude a mint failed and
mint twice. Should poll by signature on reconnect.

### 5.3 Airdrop execution is unwritten

Snapshot, preflight and CSV export are done. Batched transfer execution — with
the idempotency key already defined in `airdropPreflight.ts` — is not. The send
button is disabled rather than half-working.

### 5.4 Creator-fee claim execution is unwritten

PDAs and discriminators are pinned from the live IDLs and balances are read. The
two-instruction claim transaction is not built.

### 5.5 No rarity ranks

`NftCard` and the gallery accept a `rank`, but nothing computes it. Needs a
script over the 1,000 metadata files.

---

## 6. Operational risks

- **Program upgrade authority** is a single key. Whoever holds it can replace the
  program and drain the treasury, regardless of everything above. Consider a
  multisig, or burning it once stable — burning also forfeits the ability to
  patch a bug.
- **The floor is denominated in $PUMPBROKER.** If the token goes to zero, so does
  the floor in dollar terms. Stated plainly on the docs page.
- **A large holder can drain the surplus** by minting and immediately redeeming
  in bulk — each cycle costs them 50,000 tokens, so it is self-limiting and
  profitable only to the treasury. Not a vulnerability; worth understanding.

---

## 7. Before mainnet — blocking

1. Run `anchor test` and confirm every integration test passes (§5.1).
2. Run the devnet lifecycle end to end and watch the invariant hold.
3. Decide on §3 (randomness). **My recommendation: commit-reveal, because of the
   airdrop pieces.**
4. Decide the upgrade-authority policy (§6).
5. Get an independent review. I wrote this code; my review of it is worth less
   than a stranger's.
