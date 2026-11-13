/**
 * Local stand-ins for everything the plugin and broker talk to, so the whole flow runs offline
 * (apart from the DA SDK itself, which is loaded from da.live as in production).
 *
 *   http://localhost:3400/dev/host.html   mock Experience Workspace host (editor + plugin iframe)
 *   http://localhost:3400/tools/...       the plugin (plugin/tools), as the App Builder static hosting serves it
 *   http://localhost:3400/mock-da/...     mock DA Admin: config (with x-da-actions) and source (ETag, If-Match)
 *   http://localhost:3401/api/v1/edits    mock Sapling grammar endpoint
 *
 * Tokens: "dev-admin" can write the config (admin); "dev-author" can only read it.
 * Sapling key: dev-sapling-key-1234
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 3400);
const SAPLING_PORT = Number(process.env.SAPLING_PORT || 3401);
const SAPLING_KEY = 'dev-sapling-key-1234';
const TOKENS = { 'dev-admin': '/=read,write', 'dev-author': '/=read' };
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
};

const config = {
  ':type': 'multi-sheet',
  ':names': ['data', 'library', 'terms'],
  data: {
    data: [
      { key: 'copycheck.provider', value: 'sapling' },
      { key: 'copycheck.endpoint', value: `http://localhost:${SAPLING_PORT}` },
      { key: 'copycheck.budget', value: '200000' },
      { key: 'copycheck.language', value: 'en-AU' },
      { key: 'copycheck.applyall', value: 'spelling, term-case' },
      { key: 'copycheck.skipblocks', value: 'product-specs' },
      { key: 'copycheck.protect', value: '\\b[A-Z]{3}-\\d{4}\\b' },
    ],
  },
  library: { data: [{ title: 'Copy Check', path: `http://localhost:${PORT}/tools/copy-check/copy-check.html`, experience: 'dialog' }] },
  terms: {
    data: [
      { term: 'AEM', type: 'use carefully', replacement: 'Adobe Experience Manager', note: 'Spell out on first use' },
      { term: 'best in class', type: 'do not use', replacement: '', note: 'Not an approved claim' },
      { term: 'click here', type: 'do not use', replacement: 'the link text', note: 'Accessibility' },
      { term: 'Edge Delivery Services', type: 'approved', replacement: '', note: 'Capitalise all three words' },
      { term: 'Frescopa', type: 'approved', replacement: '', note: '' },
    ],
  },
};

const sources = new Map();
const etagOf = (body) => `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;

async function sampleSource() {
  return readFile(join(ROOT, 'dev/sample-page.html'), 'utf8');
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag, X-da-actions', ...headers });
  res.end(body);
}

function tokenOf(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

async function handleDa(req, res, path) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, '', { 'Access-Control-Allow-Headers': 'Authorization, If-Match, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT' });
  }
  const actions = TOKENS[tokenOf(req)];
  if (!actions) return send(res, 401, '');
  if (path === '/_reset') {
    sources.clear();
    return send(res, 200, 'reset');
  }
  if (path.startsWith('/list/acme/demo')) {
    return send(res, 200, '[]', { 'Content-Type': 'application/json' });
  }
  if (path.startsWith('/config/acme/demo')) {
    return send(res, 200, JSON.stringify(config), { 'Content-Type': 'application/json', 'X-da-actions': actions });
  }
  const m = path.match(/^\/source\/acme\/demo(\/.+\.html)$/);
  if (!m) return send(res, 404, '');
  const key = m[1];
  if (!sources.has(key)) sources.set(key, await sampleSource());
  if (req.method === 'GET') {
    const body = sources.get(key);
    return send(res, 200, body, { 'Content-Type': 'text/html', ETag: etagOf(body), 'X-da-actions': actions });
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    if (!actions.includes('write') && !actions.includes('read')) return send(res, 403, '');
    const ifMatch = req.headers['if-match'];
    if (ifMatch && ifMatch !== etagOf(sources.get(key))) return send(res, 412, '');
    const raw = await readBody(req);
    const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
    const data = form.get('data');
    const body = typeof data === 'string' ? data : await data.text();
    sources.set(key, body);
    console.log(`[da] wrote ${key} (${ifMatch ? `If-Match ${ifMatch}` : 'unconditional'})`);
    return send(res, 200, '', { ETag: etagOf(body) });
  }
  return send(res, 405, '');
}

async function handleStatic(req, res, path) {
  if (!/^\/(tools|dev)\//.test(path)) return send(res, 404, 'not found');
  const base = path.startsWith('/tools/') ? join(ROOT, 'plugin') : ROOT;
  const file = normalize(join(base, decodeURIComponent(path)));
  if (!file.startsWith(ROOT)) return send(res, 404, 'not found');
  try {
    const body = await readFile(file);
    return send(res, 200, body, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  } catch {
    return send(res, 404, 'not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/mock-da/')) return await handleDa(req, res, url.pathname.slice('/mock-da'.length));
    if (url.pathname === '/') return send(res, 302, '', { Location: '/dev/host.html' });
    return await handleStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    return send(res, 500, String(e));
  }
}).listen(PORT, () => console.log(`Mock host and DA on http://localhost:${PORT}/dev/host.html`));

/* ---------- mock Sapling ---------- */

const SPELLING = {
  teh: 'the', recieve: 'receive', seperate: 'separate', definately: 'definitely', occured: 'occurred',
};

function saplingEdits(text) {
  const edits = [];
  for (const s of text.matchAll(/[^.!?]+[.!?]*\s*/g)) {
    const sentence = s[0];
    const sentenceStart = s.index;
    const add = (start, end, replacement, errorType, general) => edits.push({
      id: createHash('sha1').update(`${sentenceStart}:${start}:${replacement}`).digest('hex'),
      sentence, sentence_start: sentenceStart, start, end, replacement, error_type: errorType, general_error_type: general,
    });
    for (const w of sentence.matchAll(/\b[\p{L}]+\b/gu)) {
      const fix = SPELLING[w[0].toLowerCase()];
      if (fix) add(w.index, w.index + w[0].length, w[0][0] === w[0][0].toUpperCase() ? fix[0].toUpperCase() + fix.slice(1) : fix, 'R:SPELL', 'Spelling');
    }
    for (const w of sentence.matchAll(/(?<=\s)i(?=\s)/g)) add(w.index, w.index + 1, 'I', 'R:ORTH', 'Capitalization');
    for (const w of sentence.matchAll(/\bto order and shipped\b/g)) add(w.index, w.index + w[0].length, 'to order and ships', 'R:VERB', 'Grammar');
  }
  return edits;
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/v1/edits') return send(res, 404, '');
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  if (body.key !== SAPLING_KEY) return send(res, 400, JSON.stringify({ msg: 'Invalid API key' }), { 'Content-Type': 'application/json' });
  console.log(`[sapling] ${body.text.length} chars, lang=${body.lang} variety=${body.variety} fields=${Object.keys(body).sort().join(',')}`);
  return send(res, 200, JSON.stringify({ edits: saplingEdits(body.text) }), { 'Content-Type': 'application/json' });
}).listen(SAPLING_PORT, () => console.log(`Mock Sapling on http://localhost:${SAPLING_PORT}/api/v1/edits`));
