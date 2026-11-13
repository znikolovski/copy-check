'use strict';

/**
 * Copy Check broker API (one raw web action, routed on __ow_path):
 *
 *   GET    /status       key status (last four for admins), provider, endpoint host, usage, dictionary
 *   POST   /check        { org, site, units: [{ id, text }] } -> unit-relative edits
 *   POST   /key          { org, site, key }  admins only; validated before it replaces the old key
 *   DELETE /key          admins only
 *   POST   /dictionary   { org, site, word }
 *   DELETE /dictionary   ?word=  admins only
 *
 * The key never reaches the browser. Only the provider's allow-listed paths on allow-listed hosts
 * are ever called: the broker is not a general proxy.
 */
const {
  HttpError, respond, parseRequest, corsHeaders, isAllowedOrigin, bearer, createLogger, redact,
} = require('./http');
const { initStores } = require('./storage');
const { checkCaller, assertSiteName } = require('./auth');
const {
  loadRecord, saveKey, deleteKey, keyFor, publicKeyStatus,
} = require('./key-store');
const meter = require('./meter');
const { PROVIDERS, ProviderError } = require('./providers');

const MAX_UNITS = 200;
const MAX_UNIT_CHARS = 20000;
const MAX_REQUEST_CHARS = 60000;
const CONCURRENCY = 4;
const HASH_ID = /^[0-9a-f]{64}$/;
const WORD = /^[\p{L}\p{N}'’.-]{1,64}$/u;
const KEY_FORMAT = /^[A-Za-z0-9_-]{8,200}$/;

function readConfig(params) {
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  return {
    encryptionKey: params.ENCRYPTION_KEY,
    daAdminUrl: String(params.DA_ADMIN_URL || 'https://admin.da.live').replace(/\/+$/, ''),
    allowedEndpointHosts: String(params.ALLOWED_ENDPOINT_HOSTS || 'api.sapling.ai')
      .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    defaultBudget: num(params.DEFAULT_MONTHLY_BUDGET, 5000000),
    maxBudget: num(params.MAX_MONTHLY_BUDGET, 0),
    requestsPerMinute: num(params.USER_REQUESTS_PER_MINUTE, 30),
    charsPerMinute: num(params.USER_CHARS_PER_MINUTE, 60000),
    logLevel: params.LOG_LEVEL || 'info',
  };
}

async function buildDeps(params, overrides = {}) {
  const config = { ...readConfig(params), ...(overrides.config || {}) };
  const secrets = new Set();
  if (config.encryptionKey) secrets.add(config.encryptionKey);
  const now = overrides.now || (() => Date.now());
  const log = overrides.log || createLogger(console, secrets, config.logLevel);
  const stores = overrides.state && overrides.files
    ? { state: overrides.state, files: overrides.files }
    : await initStores();
  return {
    config,
    secrets,
    now,
    log,
    fetch: overrides.fetch || globalThis.fetch,
    // Provider transport; defaults to HttpExponentialBackoff inside the provider.
    request: overrides.request,
    state: stores.state,
    files: stores.files,
  };
}

/** The provider and the endpoint from the site config, checked against the allow list. */
function providerFor(settings, config) {
  const provider = PROVIDERS[settings.provider];
  if (!provider) throw new HttpError(400, 'unknown-provider', `Provider "${settings.provider}" is not supported by this broker.`);
  let url;
  try {
    url = new URL(settings.endpoint);
  } catch {
    throw new HttpError(400, 'endpoint-not-allowed', 'copycheck.endpoint is not a valid URL.');
  }
  if (!config.allowedEndpointHosts.includes(url.host.toLowerCase()) || url.pathname.replace(/\/+$/, '') !== '' || url.search || url.hash || url.username) {
    throw new HttpError(400, 'endpoint-not-allowed', `The endpoint host ${url.host} is not allowed on this broker.`);
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new HttpError(400, 'endpoint-not-allowed', 'The endpoint must use HTTPS.');
  }
  return { provider, endpoint: url.origin };
}

function parseUnits(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_UNITS) {
    throw new HttpError(400, 'bad-request', `Send between 1 and ${MAX_UNITS} units.`);
  }
  let total = 0;
  const units = raw.map((u) => {
    const { id, text } = u || {};
    if (typeof id !== 'string' || !HASH_ID.test(id) || typeof text !== 'string' || !text || text.length > MAX_UNIT_CHARS) {
      throw new HttpError(400, 'bad-request', 'Each unit needs a content-hash id and 1 to 20,000 characters of text.');
    }
    total += text.length;
    return { id, text };
  });
  if (total > MAX_REQUEST_CHARS) throw new HttpError(413, 'too-large', 'Too much text in one request. Send it in batches.');
  return units;
}

async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

async function check({
  q, org, site, caller, deps,
}) {
  const units = parseUnits(q.units);
  const { settings } = caller;
  const { provider, endpoint } = providerFor(settings, deps.config);
  const key = keyFor(await loadRecord(deps.files, org, site), deps);
  const now = deps.now();

  const hashes = units.map((u) => meter.cacheHash({
    org, site, provider: provider.name, version: provider.version, endpoint, language: settings.language, text: u.text,
  }));
  const distinct = [...new Set(hashes)];
  const cached = await Promise.all(distinct.map((h) => meter.cacheGet(deps.state, h)));
  const hits = new Map(distinct.map((h, i) => [h, cached[i]]).filter(([, edits]) => Array.isArray(edits)));
  const misses = new Map();
  units.forEach((u, i) => {
    if (!hits.has(hashes[i]) && !misses.has(hashes[i])) misses.set(hashes[i], u.text);
  });
  const reserved = [...misses.values()].reduce((n, t) => n + t.length, 0);

  await meter.takeRate(deps.state, caller.userId || caller.callerKey, reserved, {
    requestsPerMinute: deps.config.requestsPerMinute, charsPerMinute: deps.config.charsPerMinute,
  }, now);
  await meter.reserve(deps.state, {
    org, site, chars: reserved, budget: settings.budget, now,
  });

  const fetched = new Map();
  let billed = 0;
  let fatal = null;
  try {
    await pool([...misses], CONCURRENCY, async ([hash, text]) => {
      if (fatal) return;
      try {
        const result = await provider.check(text, {
          endpoint, key, language: settings.language, request: deps.request,
        });
        billed += result.billed;
        fetched.set(hash, result.edits);
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        // Bill conservatively: anything that may have reached the provider counts.
        billed += e.billed || 0;
        if (e.code === 'invalid-key' || e.code === 'quota') fatal = e;
        else deps.log.warn('provider error', org, site, e.code);
      }
    });
  } finally {
    await meter.settle(deps.state, {
      org, site, reserved, billed, dropped: Number(q.telemetry && q.telemetry.dropped) || 0, now,
    });
  }
  await Promise.all([...fetched].map(([hash, edits]) => meter.cachePut(deps.state, hash, edits)));

  if (fatal && fatal.code === 'invalid-key') throw new HttpError(502, 'invalid-key', 'The provider key is wrong or revoked. An administrator must set a new one.');
  if (fatal && fatal.code === 'quota') throw new HttpError(429, 'provider-quota', 'The provider quota is spent for this period.');
  if (misses.size && !fetched.size) throw new HttpError(503, 'unavailable', 'The spelling and grammar service is unavailable.');

  const usage = await meter.readUsage(deps.state, org, site, now);
  return {
    provider: { name: provider.name, version: provider.version },
    results: units.flatMap((u, i) => {
      const edits = hits.get(hashes[i]) || fetched.get(hashes[i]);
      return edits ? [{ id: u.id, edits, cached: hits.has(hashes[i]) }] : [];
    }),
    usage: { used: usage.chars, budget: settings.budget },
  };
}

async function status({
  org, site, caller, deps,
}) {
  const { settings } = caller;
  const now = deps.now();
  const [record, usage, dictionary] = await Promise.all([
    loadRecord(deps.files, org, site),
    meter.readUsage(deps.state, org, site, now),
    meter.readDictionary(deps.files, org, site),
  ]);
  const provider = PROVIDERS[settings.provider];
  let endpointHost = '';
  try {
    endpointHost = new URL(settings.endpoint).host;
  } catch {
    // reported by /check
  }
  return {
    ...publicKeyStatus(record, caller.admin),
    isAdmin: caller.admin,
    provider: settings.provider,
    providerVersion: provider ? provider.version : null,
    providerSupported: Boolean(provider),
    endpointHost,
    endpointAllowed: deps.config.allowedEndpointHosts.includes(endpointHost.toLowerCase()),
    language: settings.language,
    budget: settings.budget,
    used: usage.chars,
    requests: usage.requests,
    dropped: caller.admin ? usage.dropped : undefined,
    month: meter.monthOf(now),
    resetDate: meter.resetDateOf(now),
    dictionary,
  };
}

async function setKey({
  q, org, site, caller, deps,
}) {
  const key = typeof q.key === 'string' ? q.key.trim() : '';
  if (!KEY_FORMAT.test(key)) throw new HttpError(400, 'invalid-key', 'That does not look like a provider key.');
  deps.secrets.add(key);
  if (!deps.config.encryptionKey) throw new HttpError(500, 'broker-misconfigured', 'The broker has no encryption key.');
  const { provider, endpoint } = providerFor(caller.settings, deps.config);
  let validation;
  try {
    validation = await provider.validateKey({ endpoint, key, request: deps.request });
  } catch (e) {
    if (e instanceof ProviderError && e.code === 'invalid-key') {
      throw new HttpError(400, 'invalid-key', 'The provider rejected this key. Check it and try again.');
    }
    throw new HttpError(503, 'unavailable', 'The key could not be validated because the provider is unavailable. The old key is unchanged.');
  }
  const now = deps.now();
  // Validated first, then replaced in one write: rotation has no gap and a bad key never lands.
  await saveKey(deps.files, {
    org, site, key, config: deps.config, now, setBy: caller.userId,
  });
  await meter.record(deps.state, {
    org, site, chars: validation.chars, now,
  });
  deps.log.info('key set', org, site);
  return { ok: true, keyLast4: key.slice(-4), quotaSpent: validation.quotaSpent };
}

async function removeKey({ org, site, deps }) {
  await deleteKey(deps.files, org, site);
  deps.log.info('key removed', org, site);
  return { ok: true };
}

async function addWord({
  q, org, site, deps,
}) {
  const word = typeof q.word === 'string' ? q.word.trim() : '';
  if (!WORD.test(word)) throw new HttpError(400, 'bad-request', 'Add one word at a time.');
  await meter.addWord(deps.files, org, site, word);
  return { ok: true };
}

async function removeWord({
  q, org, site, deps,
}) {
  await meter.removeWord(deps.files, org, site, String(q.word || ''));
  return { ok: true };
}

const ROUTES = {
  'GET /status': { handler: status },
  'POST /check': { handler: check },
  'POST /key': { handler: setKey, admin: true },
  'DELETE /key': { handler: removeKey, admin: true },
  'POST /dictionary': { handler: addWord },
  'DELETE /dictionary': { handler: removeWord, admin: true },
};

function errorResponse(e, deps, cors) {
  const status = e instanceof HttpError ? e.status : 500;
  const body = {
    error: e instanceof HttpError ? e.code : 'internal',
    message: e instanceof HttpError ? redact(e.message, deps.secrets) : 'Something went wrong in the copy check service.',
  };
  if (e && e.extra) {
    ['resetDate', 'retryAfter', 'used', 'budget'].forEach((k) => {
      if (e.extra[k] !== undefined) body[k] = e.extra[k];
    });
  }
  if (status >= 500) deps.log.error('request failed', e && e.stack ? e.stack : e);
  else deps.log.info('request rejected', status, body.error);
  const headers = { ...cors };
  if (body.retryAfter) headers['Retry-After'] = String(body.retryAfter);
  return respond(status, body, headers);
}

async function handle(params, deps) {
  let cors = {};
  try {
    const req = parseRequest(params);
    const q = { ...req.query, ...req.body };
    const origin = req.headers.origin;
    cors = corsHeaders(origin, { org: q.org, site: q.site });
    if (req.method === 'OPTIONS') return { statusCode: 204, headers: cors };
    if (origin && !isAllowedOrigin(origin, { org: q.org, site: q.site })) {
      throw new HttpError(403, 'origin', 'This origin may not call the broker.');
    }
    const route = ROUTES[`${req.method} ${req.path}`];
    if (!route) throw new HttpError(404, 'not-found', 'Unknown endpoint.');
    const org = assertSiteName(q.org, 'org');
    const site = assertSiteName(q.site, 'site');
    const caller = await checkCaller({
      token: bearer(req.headers), org, site, needAdmin: Boolean(route.admin),
    }, deps);
    const result = await route.handler({
      req, q, org, site, caller, deps,
    });
    return respond(200, result, cors);
  } catch (e) {
    return errorResponse(e, deps, cors);
  }
}

module.exports = {
  handle, buildDeps, readConfig, providerFor, ROUTES,
};
