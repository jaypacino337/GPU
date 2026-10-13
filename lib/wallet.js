/* Solana wallet linking: base58 + ed25519 signature verification.
 * Same approach as memcoinz seats-core.ts `verifyWalletSignature`: a Solana
 * address IS the raw 32-byte ed25519 public key, so node:crypto can verify a
 * Phantom `signMessage` signature with no Solana SDK. No private keys ever
 * touch the server or the UI.
 */
const { createPublicKey, verify: edVerify } = require('crypto');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s) {
  if (typeof s !== 'string' || !s.length) throw new Error('empty base58');
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? [] : [...Buffer.from(hex, 'hex')];
  const zeros = s.match(/^1*/)[0].length;
  return Uint8Array.from([...Array(zeros).fill(0), ...body]);
}

function base58Encode(bytes) {
  bytes = Uint8Array.from(bytes);
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

function isWallet(s) {
  try {
    return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

/** true only if `signatureB58` is `wallet`'s ed25519 signature over the exact UTF-8 `message`. */
function verifyWalletSignature(wallet, message, signatureB58) {
  try {
    if (!isWallet(wallet) || typeof message !== 'string') return false;
    const sig = Buffer.from(base58Decode(signatureB58));
    if (sig.length !== 64) return false;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(base58Decode(wallet)).toString('base64url') },
      format: 'jwk',
    });
    return edVerify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/**
 * What the player signs in Phantom. Built only on the server; the client signs
 * the exact string it was handed. The nonce is single-use and expires, so a
 * captured signature can't be replayed to re-link or to link another player.
 */
const linkMessage = ({ name, tag, nonce, issuedAt }) =>
  [
    'CSTR · Chip Strategy',
    `Link this wallet to player "${name}" (#${tag}) for leaderboard rewards.`,
    'This signature is free and does not send a transaction.',
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
  ].join('\n');

module.exports = { base58Decode, base58Encode, isWallet, verifyWalletSignature, linkMessage };
