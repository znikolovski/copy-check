'use strict';

const { HttpError } = require('./http');
const { sha256 } = require('./crypto');

const ACL_TTL = 60;
const NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

function assertSiteName(value, label) {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new HttpError(400, 'bad-request', `A valid ${label} is required.`);
  }
  return value.toLowerCase();
}

function decodeIdentity(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { id: payload.user_id || payload.sub || null };
  } catch {
    return { id: null };
  }
}

/** Parses `x-da-actions: /org/site=read,write` into a set of actions. */
function parseDaActions(header) {
  if (!header) return new Set();
  const value = String(header).split('=').pop();
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Copy Check settings from the site config. Budget, provider, endpoint and language always come
 * from here (only admins can edit it), never from a request.
 */
function readSettings(json, config) {
  const values = {};
  if (!json || typeof json !== 'object') json = {};
  const sheets = json[':type'] === 'multi-sheet'
    ? (json[':names'] || Object.keys(json).filter((k) => !k.startsWith(':'))).map((n) => (json[n] && json[n].data) || [])
    : [json.data || []];
  sheets.forEach((rows) => rows.forEach((row) => {
    const key = String(row.key ?? row.Key ?? '').trim().toLowerCase();
    if (key.startsWith('copycheck.')) values[key.slice(10)] = String(row.value ?? row.Value ?? '').trim();
  }));
  const requested = values.budget ? Number(values.budget) : Number.NaN;
  const base = Number.isFinite(requested) && requested >= 0 ? requested : config.defaultBudget;
  return {
    provider: (values.provider || 'sapling').toLowerCase(),
    endpoint: (values.endpoint || 'https://api.sapling.ai').replace(/\/+$/, ''),
    budget: Math.min(base, config.maxBudget || Infinity),
    language: values.language || 'en',
  };
}

async function daFetch(deps, path, token) {
  try {
    return await deps.fetch(`${deps.config.daAdminUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new HttpError(503, 'unavailable', 'Experience Workspace could not be reached to check access.');
  }
}

/**
 * The broker keeps no user list. It asks DA whether the caller can read the site, and whether
 * the caller can write the site configuration (administrator). The answer and the site's
 * settings are cached for a minute per token.
 */
async function checkCaller({
  token, org, site, needAdmin = false,
}, deps) {
  if (!token) throw new HttpError(401, 'not-signed-in', 'Sign in to Experience Workspace first.');
  const tokenHash = sha256(token);
  const key = `acl-${tokenHash.slice(0, 32)}-${org}-${site}`;
  let acl = await deps.state.get(key);
  if (!acl) {
    const list = await daFetch(deps, `/list/${org}/${site}`, token);
    if (list.status === 401) throw new HttpError(401, 'not-signed-in', 'Your session has expired. Reload Experience Workspace.');
    const read = list.ok;
    let admin = false;
    let settings = readSettings(null, deps.config);
    if (read) {
      const cfg = await daFetch(deps, `/config/${org}/${site}/`, token);
      if (cfg.ok) {
        admin = parseDaActions(cfg.headers.get('x-da-actions')).has('write');
        try {
          settings = readSettings(await cfg.json(), deps.config);
        } catch {
          // An unreadable config means defaults.
        }
      }
    }
    acl = { read, admin, settings };
    await deps.state.put(key, acl, ACL_TTL);
  }
  if (!acl.read) throw new HttpError(403, 'not-allowed', 'You do not have access to this site.');
  if (needAdmin && !acl.admin) throw new HttpError(403, 'admin-only', 'Only site administrators can change this.');
  return {
    read: acl.read,
    admin: acl.admin,
    settings: acl.settings,
    userId: decodeIdentity(token).id,
    callerKey: tokenHash.slice(0, 24),
  };
}

module.exports = {
  checkCaller, readSettings, parseDaActions, decodeIdentity, assertSiteName,
};
