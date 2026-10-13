const crypto = require('crypto');
const { base58Encode } = require('../lib/wallet');

/** A throwaway ed25519 keypair, as a Phantom wallet would hold it. Test-only. */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return {
    address: base58Encode(raw),
    sign: (msg) => base58Encode(crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey)),
  };
}

module.exports = { keypair };
