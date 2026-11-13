'use strict';

const crypto = require('node:crypto');

const ALG = 'aes-256-gcm';

function loadMasterKey(b64) {
  if (!b64) throw new Error('ENCRYPTION_KEY is not configured');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return key;
}

const b64 = (buf) => buf.toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

/**
 * Envelope encryption: a fresh data key encrypts the secret, and the master key
 * (only available to the broker runtime) wraps the data key.
 * `aad` binds the ciphertext to its site so a record cannot be moved to another site.
 */
function seal(plaintext, masterKey, aad = '') {
  const dataKey = crypto.randomBytes(32);
  const withAad = (key, data) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    return { iv, ct, tag: cipher.getAuthTag() };
  };
  const wrapped = withAad(masterKey, dataKey);
  const body = withAad(dataKey, Buffer.from(plaintext, 'utf8'));
  return {
    v: 1,
    alg: 'A256GCM+A256GCMKW',
    wk: { iv: b64(wrapped.iv), ct: b64(wrapped.ct), tag: b64(wrapped.tag) },
    iv: b64(body.iv),
    ct: b64(body.ct),
    tag: b64(body.tag),
  };
}

function open(envelope, masterKey, aad = '') {
  const withAad = (key, part) => {
    const decipher = crypto.createDecipheriv(ALG, key, unb64(part.iv));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(unb64(part.tag));
    return Buffer.concat([decipher.update(unb64(part.ct)), decipher.final()]);
  };
  const dataKey = withAad(masterKey, envelope.wk);
  return withAad(dataKey, envelope).toString('utf8');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

module.exports = {
  loadMasterKey, seal, open, sha256,
};
