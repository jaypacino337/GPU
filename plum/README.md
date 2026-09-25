# Plum

An agentic browser for onchain work. Companions read your positions and compose
your transactions; **they cannot sign.** Every state change stops at a gate that
shows a simulated balance diff first.

The [landing page](https://claude.ai/artifact/25CXPJ6DzHLLMPg9qRbVpv) describes
the product. This repo is the engine behind the claim it makes.

## Why this exists as a library first

The interesting part of Plum is not the browser chrome, it is the answer to one
question: *what would this transaction actually do to my balances?* Get that
wrong and the gate is theatre.

So the engine is network-free and the chain adapters are swappable. Everything
safety-critical — decoding, the diff, risk classification, the run state machine
— is pure and tested without an RPC. Adapters are thin and tested against a real
EVM.

```
src/engine/    no network, no framework
  types.ts     amounts are bigint, everywhere, without exception
  decode.ts    ERC-20 / ERC-721 log decoding
  diff.ts      simulation outcome -> signed balance deltas
  risk.ts      deltas + approvals -> gate decision
  run.ts       skills, and the run state machine
src/chain/
  simulator.ts Simulator port + three implementations
contracts/     a minimal ERC-20, used only by the end-to-end test
test/
```

## The three rules the tests enforce

**1. A companion never signs.** `decideGate` returns `requiresSignature: true`
for every input — success, revert, unsimulatable, harmless revocation, inbound
transfer, zero-value call. There is no allowlist, no trusted-contract path and no
severity low enough to skip the gate. `test/risk.test.ts` asserts this across
every shape of input, because it is the claim the product is built on.

**2. A gate that cannot simulate says so.** Rather than deriving a
confident-looking diff from guesswork, `UnavailableSimulator` returns
`status: "unavailable"` with a reason, which becomes a danger-level finding and
an empty diff. `pickSimulator` degrades to it instead of falling back to
estimation.

**3. One signature per run.** `validateSkill` rejects a skill with more than one
write step, so a second gate can never hide behind the first.

## Simulation

| Adapter | How | Verified |
|---|---|---|
| `SnapshotSimulator` | snapshot → execute for real → read balances → revert | **yes**, against a local EVM |
| `SimulateV1Simulator` | `eth_simulateV1` | **no** — see below |
| `UnavailableSimulator` | returns a reason, no diff | yes |

`SnapshotSimulator` is the most accurate: real logs, real gas, real balances,
including anything inner calls moved. It needs a node you control — a dev chain
or a fork. Its revert is in a `finally`, and a test asserts the chain's block
number, balance and nonce are untouched afterwards, including when the simulated
call reverts.

`SimulateV1Simulator` is **written but never executed.** The local dev node does
not implement `eth_simulateV1`, and no public RPC is reachable from the
environment this was built in. Its fallback-to-unavailable path is tested; the
success path is not. Do not trust it until it has run against a real endpoint.

## Two decisions in the diff worth knowing about

**Inflows and outflows are not netted.** A run that claims 1,284 USDC and
immediately repays 1,284 USDC nets to zero. Rendering that as `0 USDC` hides both
halves of what the transaction does, so they stay on separate rows.

**Gas is always its own row.** When an adapter provides authoritative pre/post
balances those already include gas, so gas is added back out of the movement
figure. A test asserts the two rows reconcile exactly with the real on-chain
balance change — that arithmetic is the easiest place to double-count.

## Approval shapes

The approval checks are where most real losses come from, so they are specific:

- `MAX_UINT256` **and** anything ≥ 2^255 count as unlimited. Plenty of
  front-ends approve an absurd-but-not-maximum number; over-warning is the right
  direction to be wrong in.
- `setApprovalForAll(true)` is its own danger finding, not an amount.
- An **exact** approval larger than the run actually spends is flagged too. That
  is the quiet version of the same problem: the leftover allowance outlives the
  run it was granted for.
- A known spender is never a reason to lower severity. A test asserts that.

ERC-20 and ERC-721 `Transfer` share a selector, so they are told apart by shape
(3 topics + 32 bytes of data, versus 4 topics and empty data). Misreading an NFT
transfer as ERC-20 would report a balance change of `tokenId` base units — for
token id 8171, a nonsense number shown to someone about to sign. There is a test
named after exactly that.

## Running it

```bash
npm install
npm test          # 83 tests

# The end-to-end tests need a dev chain. Without one they skip, loudly.
npx hardhat node  # in another terminal
npm test
```

The end-to-end suite refuses to run against anything but chain 31337, and skips
with the reason printed rather than failing, since a missing dev node is an
environment gap and not a regression.

To regenerate the test token after editing `contracts/TestToken.sol`:

```bash
cd contracts && node ../node_modules/.bin/solcjs --bin --abi --optimize TestToken.sol -o build
```

## What is not here yet

- **The browser.** This is the engine; there is no Chromium shell, no tab
  management, no model loop driving the companions.
- **Wallet connection.** The engine produces a gate decision; handing the
  approved transaction to a wallet for signature is not wired up.
- **Routines.** Scheduling exists on the landing page, not in code.
- **Token metadata.** Findings quote base units. Decimals and symbols need a
  metadata source before the gate reads the way the mockup does.
- **`eth_simulateV1` verification**, as above.
