'use strict';

const crypto = require('node:crypto');
const { buildDeps, handle } = require('../lib/router');
const { memoryState, memoryFiles } = require('../lib/storage');

const ORG = 'acme';
const GOOD_KEY = 'goodkey-0000-1234';
const TOKENS = { admin: '/=read,write', author: '/=read' };
const ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

/** Sapling-shaped, sentence-relative edits for every "teh". */
function saplingEdits(text) {
  const edits = [];
  for (const m of text.matchAll(/[^.!?]+[.!?]*\s*/g)) {
    for (const w of m[0].matchAll(/\bteh\b/g)) {
      edits.push({
        sentence: m[0], sentence_start: m.index, start: w.index, end: w.index + 3, replacement: 'the', error_type: 'R:SPELL', general_error_type: 'Spelling',
      });
    }
  }
  return edits;
}

/**
 * A world: DA admin with sites and tokens, and a Sapling whose behaviour each test sets.
 * `sapling.script` is a list of outcomes for successive attempts ('ok', 500, 429, 'network', ...).
 */
function createWorld() {
  const world = {
    sites: {},
    saplingCalls: [],
    sapling: { script: [], mode: 'ok' },
    daCalls: 0,
  };

  world.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin !== 'https://admin.da.live') return new Response('unexpected', { status: 599 });
    world.daCalls += 1;
    const token = (init.headers?.Authorization || '').slice(7);
    const [, kind, org, site] = u.pathname.split('/');
    if (!TOKENS[token] || org !== ORG || !world.sites[site]) return new Response(null, { status: token in TOKENS ? 403 : 401 });
    if (kind === 'list') return Response.json([]);
    const rows = Object.entries({ language: 'en-AU', ...world.sites[site] })
      .filter(([, v]) => v !== undefined).map(([k, v]) => ({ key: `copycheck.${k}`, value: v }));
    return Response.json({ ':type': 'multi-sheet', ':names': ['data'], data: { data: rows } }, { headers: { 'x-da-actions': TOKENS[token] } });
  };

  /** One Sapling attempt. */
  function attempt(url, init) {
    const body = JSON.parse(init.body);
    world.saplingCalls.push({ url, body });
    const outcome = world.sapling.script.length ? world.sapling.script.shift() : world.sapling.mode;
    if (outcome === 'network') throw new TypeError('connection refused');
    if (typeof outcome === 'number') return new Response('fail', { status: outcome });
    if (body.key !== GOOD_KEY) return Response.json({ msg: 'Invalid API key' }, { status: 400 });
    return Response.json({ edits: saplingEdits(body.text) });
  }

  /** Same contract as HttpExponentialBackoff.exponentialBackoff (fetch-retry semantics), without delays. */
  world.request = async (url, init, retryOptions, retryOn) => {
    for (let i = 0; ; i += 1) {
      let response = null;
      let error = null;
      try {
        response = attempt(url, init);
      } catch (e) {
        error = e;
      }
      if (!retryOn(i, error, response)) {
        if (error) throw error;
        return response;
      }
    }
  };
  return world;
}

async function makeDeps(world, extra = {}) {
  return buildDeps({}, {
    config: {
      encryptionKey: ENCRYPTION_KEY, allowedEndpointHosts: ['api.sapling.ai', 'sapling.onprem.example'], ...extra.config,
    },
    state: extra.state || memoryState(),
    files: extra.files || memoryFiles(),
    fetch: world.fetch,
    request: world.request,
    now: extra.now,
    log: {
      debug() {}, info() {}, warn() {}, error() {},
    },
  });
}

/** Invoke the action the way I/O Runtime does for a raw web action. */
async function call(deps, method, path, {
  token = 'author', body, query = {}, origin = 'https://28538-copycheck.adobeio-static.net',
} = {}) {
  const res = await handle({
    __ow_method: method.toLowerCase(),
    __ow_path: path,
    __ow_headers: { authorization: token ? `Bearer ${token}` : undefined, origin, 'content-type': 'application/json' },
    __ow_query: new URLSearchParams(query).toString(),
    __ow_body: body ? Buffer.from(JSON.stringify(body)).toString('base64') : undefined,
  }, deps);
  return { status: res.statusCode, headers: res.headers || {}, body: res.body ? JSON.parse(res.body) : null };
}

const hash = (text) => crypto.createHash('sha256').update(`client:${text}`).digest('hex');

module.exports = {
  ORG, GOOD_KEY, ENCRYPTION_KEY, createWorld, makeDeps, call, hash,
};
