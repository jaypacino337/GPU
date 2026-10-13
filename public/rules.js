/* CSTR compute-epoch rules: shared by the server (lib/mining.js) and the
 * browser (the board UI and the /rewards "verify" button). Pure functions.
 *
 * Modelled on ORE (regolith-labs/ore): a 5×5 board, 60s rounds, one winning
 * square per round from a verifiable random value, losers' stake split
 * pro-rata on the winning square, +1 token per round either split or sent to
 * one weighted-random "top miner", and a motherlode that grows +0.2 per round
 * and hits with fixed odds. Here the stake is free POWER (⚡), never SOL.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSTRRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 5;
  const SQUARES = SIZE * SIZE;
  const CHIP = 1000000;                 // 1 CHIP = 1e6 micro-chips (integer math)
  const RULES = {
    epochMs: 60000,                     // one compute epoch
    emission: 1 * CHIP,                 // CHIP minted to winners per epoch (ORE: +1 ORE)
    motherlodePerEpoch: 0.2 * CHIP,     // added to the jackpot each epoch (ORE: +0.2)
    motherlodeOdds: 500,                // 1 in 500 per epoch (ORE's current program)
    burnBps: 1000,                      // 10% of losing power burned (ORE: 10% protocol cut)
    minDeploy: 1,                       // ⚡ per rack
    maxDeploy: 1000,                    // ⚡ per rack per call
    startPower: 300,
    regenPerMin: 10,                    // ⚡ per minute while you're online
    regenCap: 600,                      // regen stops at this balance (winnings can exceed it)
  };

  // Rack labels: columns A–E, rows 1–5 (A1 top-left).
  const label = (i) => 'ABCDE'[i % SIZE] + (Math.floor(i / SIZE) + 1);

  const u64 = (hex, k) => BigInt('0x' + hex.slice(k * 16, k * 16 + 16));

  /**
   * Everything random about an epoch, read from its 32-byte value:
   *   word0 % 25            → winning rack
   *   word1 even            → +1 CHIP split pro-rata (else one top miner, 50/50 like ORE)
   *   word2 % power-on-rack → top-miner sample (cumulative, in deploy order)
   *   word3 % odds == 0     → motherlode hit
   */
  function outcome(valueHex, powerOnWinner, odds = RULES.motherlodeOdds) {
    if (!/^[0-9a-f]{64}$/.test(valueHex)) throw new Error('bad value');
    const square = Number(u64(valueHex, 0) % BigInt(SQUARES));
    const split = u64(valueHex, 1) % 2n === 0n;
    const sample = powerOnWinner > 0 ? Number(u64(valueHex, 2) % BigInt(powerOnWinner)) : null;
    const motherlode = u64(valueHex, 3) % BigInt(odds) === 0n;
    return { square, split, sample, motherlode };
  }

  return { SIZE, SQUARES, CHIP, RULES, label, outcome };
});
