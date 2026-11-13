'use strict';

const { seal, open, loadMasterKey } = require('./crypto');
const { HttpError } = require('./http');

const recordPath = (org, site) => `keys/${org}/${site}.json`;
const aadFor = (org, site) => `copy-check:${org}/${site}`;

async function loadRecord(files, org, site) {
  return files.readJson(recordPath(org, site));
}

/** Seals the provider key with a fresh data key, bound to the site, and replaces the record in one write. */
async function saveKey(files, {
  org, site, key, config, now, setBy,
}) {
  const record = {
    org,
    site,
    secret: seal(key, loadMasterKey(config.encryptionKey), aadFor(org, site)),
    meta: { last4: key.slice(-4), setAt: now, setBy: setBy || null },
  };
  await files.writeJson(recordPath(org, site), record);
  return record;
}

async function deleteKey(files, org, site) {
  await files.delete(recordPath(org, site));
}

/** Returns the provider key for a record. The decrypted value is registered for log redaction. */
function keyFor(record, deps) {
  if (!record || !record.secret) throw new HttpError(409, 'no-key', 'Spelling and grammar checks are not set up for this site yet.');
  let key;
  try {
    key = open(record.secret, loadMasterKey(deps.config.encryptionKey), aadFor(record.org, record.site));
  } catch {
    throw new HttpError(500, 'broker-misconfigured', 'The stored key cannot be read. An administrator must set it again.');
  }
  deps.secrets.add(key);
  return key;
}

/** The only shape of a key record that ever leaves the broker. */
function publicKeyStatus(record, isAdmin) {
  if (!record) return { configured: false, keyLast4: null, keySetAt: null };
  return {
    configured: true,
    keyLast4: isAdmin ? record.meta.last4 : null,
    keySetAt: isAdmin ? record.meta.setAt : null,
  };
}

module.exports = {
  loadRecord, saveKey, deleteKey, keyFor, publicKeyStatus, recordPath,
};
