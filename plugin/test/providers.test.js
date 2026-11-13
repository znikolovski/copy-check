import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, LIVE_PAGE } from './helpers.js';
import { extractUnits } from '../tools/copy-check/lib/units.js';
import { createCache } from '../tools/copy-check/lib/cache.js';
import { createRemoteProvider, remoteFindings, localFindings } from '../tools/copy-check/lib/providers.js';
import { createBrokerClient, BrokerError } from '../tools/copy-check/lib/broker-client.js';
import { parseTerms } from '../tools/copy-check/lib/terms.js';

function memory() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}

function fakeBroker(editsFor = () => []) {
  const calls = [];
  return {
    calls,
    check: async (units) => {
      calls.push(units);
      return { results: units.map((u) => ({ id: u.id, edits: editsFor(u.text) })), usage: { used: 1 } };
    },
  };
}

const sapling = (broker, cache) => createRemoteProvider({
  broker, cache, provider: 'sapling', version: 'edits-v1', language: 'en-AU',
});

test('sends only eligible text, under hash ids, once per distinct text', async () => {
  const doc = parse('<main><div><p>Same text.</p><p>Same text.</p><p><a href="/x">click here</a></p></div></main>');
  const { units } = extractUnits(doc);
  const broker = fakeBroker();
  const provider = sapling(broker, createCache({ storage: memory() }));
  const out = await provider.check(units);
  assert.equal(broker.calls.length, 1);
  const sent = broker.calls[0];
  assert.equal(sent.length, 2, 'duplicate text is sent once; link units are local-only');
  assert.ok(sent.every((u) => /^[0-9a-f]{64}$/.test(u.id)), 'ids are content hashes, not block names');
  assert.ok(out.entries.has('p:0') && out.entries.has('p:1'));
});

test('cache: an unchanged unit is never sent twice', async () => {
  const { units } = extractUnits(parse(LIVE_PAGE));
  const broker = fakeBroker();
  const cache = createCache({ storage: memory() });
  await sapling(broker, cache).check(units);
  const est = await sapling(broker, cache).estimate(units);
  await sapling(broker, cache).check(units);
  assert.equal(broker.calls.length, 1);
  assert.equal(est.toSend, 0);
  assert.ok(est.total > 0);
});

test('cache key includes provider version and language', async () => {
  const { units } = extractUnits(parse(LIVE_PAGE));
  const broker = fakeBroker();
  const cache = createCache({ storage: memory() });
  await sapling(broker, cache).check(units);
  await createRemoteProvider({
    broker, cache, provider: 'sapling', version: 'edits-v2', language: 'en-AU',
  }).check(units);
  assert.equal(broker.calls.length, 2);
});

test('provider unavailable: stale cache is used with its age, the rest is unchecked', async () => {
  const doc = parse('<main><div><p>Cached text.</p><p>New text.</p></div></main>');
  const { units } = extractUnits(doc);
  let now = 0;
  const cache = createCache({ storage: memory(), now: () => now });
  await sapling(fakeBroker(() => [{ start: 0, end: 6, replacement: 'Cache', type: 'spelling' }]), cache).check([units[0]]);
  now = 40 * 24 * 3600 * 1000; // past freshness
  const failing = { check: async () => { throw new BrokerError(503, { error: 'unavailable' }); } };
  const out = await sapling(failing, cache).check(units);
  assert.equal(out.error.code, 'unavailable');
  assert.equal(out.entries.get('p:0').stale, true);
  assert.deepEqual([...out.unchecked], ['p:1']);
});

test('remote findings: unmappable spans are dropped and counted; URLs, protected values and dictionary words filtered', () => {
  const doc = parse('<main><div><p>Visit <b>teh</b> www.exmaple.com for SKU-123 and Fooz.</p></div></main>');
  const [unit] = extractUnits(doc).units;
  const t = unit.text;
  const at = (w) => t.indexOf(w);
  const edits = [
    { start: at('Visit'), end: at('teh') + 3, replacement: 'Visit the', type: 'grammar' }, // crosses <b>
    { start: at('teh'), end: at('teh') + 3, replacement: 'the', type: 'spelling' },
    { start: at('exmaple'), end: at('exmaple') + 7, replacement: 'example', type: 'spelling' },
    { start: at('SKU'), end: at('SKU') + 7, replacement: 'SKU 123', type: 'grammar' },
    { start: at('Fooz'), end: at('Fooz') + 4, replacement: 'Foo', type: 'spelling' },
  ];
  let dropped = 0;
  const findings = remoteFindings(unit, { edits, at: 1 }, {
    source: 'sapling', protect: /SKU-\d+/g, ignoreWords: new Set(['fooz']), onDropped: () => { dropped += 1; },
  });
  assert.equal(dropped, 1);
  assert.deepEqual(findings.map((f) => f.original), ['teh']);
  assert.match(findings[0].message, /“teh” → “the”/);
});

test('local findings include page rules only when asked', () => {
  const { units } = extractUnits(parse('<main><div><p>AEM rocks.</p></div></main>'));
  const rules = parseTerms([{ term: 'AEM', type: 'use carefully', replacement: 'Adobe Experience Manager' }]);
  assert.equal(localFindings(units, rules).length, 1);
  assert.equal(localFindings(units, rules, { includePage: true }).length, 2);
});

test('broker client: bearer token, org and site, and structured errors', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url: String(url), opts });
    if (opts.method === 'POST') return Response.json({ error: 'budget-exhausted', message: 'Spent', resetDate: '2026-12-01' }, { status: 429 });
    return Response.json({ configured: true });
  };
  const client = createBrokerClient({
    baseUrl: 'https://b.example', getToken: () => 'tok', org: 'o', site: 's', fetchImpl,
  });
  assert.deepEqual(await client.status(), { configured: true });
  assert.equal(seen[0].url, 'https://b.example/status?org=o&site=s');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer tok');
  await assert.rejects(client.check([{ id: 'h', text: 't' }]), (e) => e.code === 'budget-exhausted' && e.resetDate === '2026-12-01');
  assert.deepEqual(JSON.parse(seen[1].opts.body), { org: 'o', site: 's', units: [{ id: 'h', text: 't' }] });
  const down = createBrokerClient({
    baseUrl: 'https://b.example', getToken: () => 't', org: 'o', site: 's', fetchImpl: async () => { throw new TypeError('net'); },
  });
  await assert.rejects(down.status(), (e) => e.code === 'unavailable');
});

test('protected ranges apply to house style too: a term inside a domain is never changed', async () => {
  const { withoutProtected } = await import('../tools/copy-check/lib/providers.js');
  const { checkTerms } = await import('../tools/copy-check/lib/terms.js');
  const doc = parse('<main><div><p>Visit frescopa.coffee or ask frescopa about SKU-4410.</p></div></main>');
  const { units } = extractUnits(doc);
  const rules = parseTerms([{ term: 'Frescopa', type: 'approved' }, { term: 'SKU-4410', type: 'do not use', replacement: 'x' }]);
  const all = checkTerms(units, rules);
  assert.equal(all.length, 3);
  const kept = withoutProtected(all, /SKU-\d+/g);
  assert.deepEqual(kept.map((f) => f.original), ['frescopa']);
  assert.equal(kept[0].start, units[0].text.indexOf('ask frescopa') + 4);
});
