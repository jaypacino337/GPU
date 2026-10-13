const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { base58Decode, base58Encode, isWallet, verifyWalletSignature, linkMessage } = require('../lib/wallet');
const { keypair } = require('./helpers');

test('base58 round-trips, including leading zero bytes', () => {
  for (const bytes of [[0, 0, 1, 2, 3], [255, 254], crypto.randomBytes(32), crypto.randomBytes(64)]) {
    assert.deepEqual([...base58Decode(base58Encode(bytes))], [...bytes]);
  }
  // Known vector: the system program id is 32 zero bytes.
  assert.equal(base58Encode(new Uint8Array(32)), '11111111111111111111111111111111');
});

test('isWallet accepts real addresses, rejects junk', () => {
  assert.ok(isWallet(keypair().address));
  assert.ok(isWallet('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
  for (const bad of ['', 'abc', '0OIl' + 'a'.repeat(40), 'x'.repeat(44), null, 42]) assert.equal(isWallet(bad), false);
});

test('valid signature verifies', () => {
  const kp = keypair();
  const msg = linkMessage({ name: 'ChipBaron', tag: 'ab12cd34', nonce: 'n1', issuedAt: 0 });
  assert.ok(verifyWalletSignature(kp.address, msg, kp.sign(msg)));
});

test('signature over a different message is rejected (nonce replay)', () => {
  const kp = keypair();
  const a = linkMessage({ name: 'p', tag: 't', nonce: 'old', issuedAt: 0 });
  const b = linkMessage({ name: 'p', tag: 't', nonce: 'new', issuedAt: 0 });
  assert.equal(verifyWalletSignature(kp.address, b, kp.sign(a)), false);
});

test("someone else's signature is rejected", () => {
  const alice = keypair();
  const mallory = keypair();
  const msg = 'link me';
  assert.equal(verifyWalletSignature(alice.address, msg, mallory.sign(msg)), false);
});

test('tampered / malformed signatures are rejected, never throw', () => {
  const kp = keypair();
  const msg = 'hello';
  const sig = base58Decode(kp.sign(msg));
  sig[10] ^= 1;
  assert.equal(verifyWalletSignature(kp.address, msg, base58Encode(sig)), false);
  for (const bad of ['', 'not-base58!', base58Encode([1, 2, 3]), undefined, null, 123]) {
    assert.equal(verifyWalletSignature(kp.address, msg, bad), false);
  }
  assert.equal(verifyWalletSignature('not a wallet', msg, kp.sign(msg)), false);
});

test('link message names the player and states no transaction is sent', () => {
  const m = linkMessage({ name: 'Zed', tag: 'deadbeef', nonce: 'abc', issuedAt: Date.parse('2026-10-05T00:00:00Z') });
  assert.match(m, /"Zed" \(#deadbeef\)/);
  assert.match(m, /does not send a transaction/);
  assert.match(m, /Nonce: abc/);
  assert.match(m, /Issued: 2026-10-05T00:00:00.000Z/);
});
