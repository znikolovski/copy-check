import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, parse, LIVE_PAGE } from './helpers.js';
import { extractUnits } from '../tools/copy-check/lib/units.js';
import { makeFinding } from '../tools/copy-check/lib/findings.js';
import {
  applyToDocument, correctedBlockHtml, applyInPlace, applyViaSource, sourceUrl,
} from '../tools/copy-check/lib/apply.js';

const unitsOf = (html) => extractUnits(parse(html)).units;
const finding = (units, id, word, replacement, extra = {}) => {
  const unit = units.find((u) => u.id === id);
  const start = unit.text.indexOf(word);
  assert.ok(start >= 0, `${word} in ${unit.text}`);
  return makeFinding(unit, {
    start, end: start + word.length, replacement, type: 'spelling', source: 'sapling', ...extra,
  });
};

test('applies several findings to one unit right to left', () => {
  const html = '<main><div><p>teh cat and teh dog</p></div></main>';
  const units = unitsOf(html);
  const unit = units[0];
  const f1 = makeFinding(unit, { start: 0, end: 3, replacement: 'The', type: 'spelling', source: 'sapling' });
  const f2 = makeFinding(unit, { start: 12, end: 15, replacement: 'the', type: 'spelling', source: 'sapling' });
  const doc = parse(html);
  const { applied, skipped } = applyToDocument(extractUnits(doc), [f1, f2]);
  assert.equal(applied.length, 2);
  assert.equal(skipped.length, 0);
  assert.equal(doc.querySelector('p').textContent, 'The cat and the dog');
});

test('skips findings whose text changed, and advisory findings', () => {
  const units = unitsOf('<main><div><p>teh cat</p></div></main>');
  const f = makeFinding(units[0], { start: 0, end: 3, replacement: 'the', type: 'spelling', source: 'sapling' });
  const advisory = makeFinding(units[0], { start: 0, end: 3, replacement: null, type: 'term', source: 'terms' });
  const doc = parse('<main><div><p>teh cats</p></div></main>');
  const { applied, skipped } = applyToDocument(extractUnits(doc), [f, advisory]);
  assert.equal(applied.length, 0);
  assert.deepEqual(skipped.map((s) => s.reason).sort(), ['advisory', 'changed']);
});

test('corrected block HTML: only the block, without editor instrumentation, alt text included', () => {
  const units = unitsOf(LIVE_PAGE);
  const f = finding(units, 'cards:0:1.1', 'edge delivery services', 'Edge Delivery Services', { type: 'term', source: 'terms' });
  const out = correctedBlockHtml(LIVE_PAGE, 0, [f], { DOMParserImpl: DOMParser });
  assert.equal(out.applied.length, 1);
  assert.match(out.html, /^<div class="cards">/);
  assert.match(out.html, /Edge Delivery Services/);
  assert.doesNotMatch(out.html, /data-block-index|data-prose-index/);
});

test('route A sends a guarded replace for the selected block', async () => {
  const units = unitsOf(LIVE_PAGE);
  const f = finding(units, 'cards:0:1', 'is is', 'is');
  let sent;
  const actions = {
    sendHTML: async (html, opts) => {
      sent = { html, opts };
      return { ok: true, html: '<main></main>', selection: { blockIndex: 0 } };
    },
  };
  const snapshot = { html: LIVE_PAGE, selection: { blockIndex: 0 } };
  const result = await applyInPlace({
    actions, snapshot, findings: [f], DOMParserImpl: DOMParser,
  });
  assert.ok(result.ok);
  assert.equal(sent.opts.replace, true);
  assert.deepEqual(sent.opts.expected, { html: LIVE_PAGE, blockIndex: 0 });
  assert.match(sent.html, /First card is great\./);
});

test('route A reports host errors and never retries', async () => {
  const units = unitsOf(LIVE_PAGE);
  const f = finding(units, 'cards:0:1', 'is is', 'is');
  let calls = 0;
  const actions = { sendHTML: async () => { calls += 1; return { ok: false, error: 'STALE_LIVE', message: 'changed' }; } };
  const result = await applyInPlace({
    actions, snapshot: { html: LIVE_PAGE, selection: { blockIndex: 0 } }, findings: [f], DOMParserImpl: DOMParser,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'STALE_LIVE');
  assert.equal(calls, 1);
});

test('source URL normalisation', () => {
  assert.equal(sourceUrl({ org: 'o', site: 's', path: '/drafts/a' }), 'https://admin.da.live/source/o/s/drafts/a.html');
  assert.equal(sourceUrl({ org: 'o', site: 's', path: '/' }), 'https://admin.da.live/source/o/s/index.html');
  assert.equal(sourceUrl({ org: 'o', site: 's', path: 'x.html' }), 'https://admin.da.live/source/o/s/x.html');
});

function fakeDa(initial) {
  const state = { body: initial, version: 1, writes: [], concurrentEdit: null };
  const daFetch = async (url, opts = {}) => {
    if (!opts.method) {
      return new Response(state.body, { status: 200, headers: { etag: `"v${state.version}"` } });
    }
    const ifMatch = opts.headers['If-Match'];
    if (state.concurrentEdit) {
      state.body = state.concurrentEdit(state.body);
      state.version += 1;
      state.concurrentEdit = null;
    }
    if (ifMatch !== `"v${state.version}"`) return new Response(null, { status: 412 });
    state.body = await opts.body.get('data').text();
    state.version += 1;
    state.writes.push(state.body);
    return new Response(null, { status: 200 });
  };
  return { state, daFetch };
}

test('route B saves, reads with a version, and writes with If-Match', async () => {
  const units = unitsOf(LIVE_PAGE);
  const f = finding(units, 'h1:0', 'teh', 'the');
  const alt = finding(units, 'p:1:alt', 'teh ', '');
  const { state, daFetch } = fakeDa(LIVE_PAGE);
  let saved = 0;
  const result = await applyViaSource({
    daFetch, org: 'o', site: 's', path: '/p', findings: [f, alt], saveDocument: async () => { saved += 1; return { ok: true }; }, DOMParserImpl: DOMParser,
  });
  assert.ok(result.ok, result.error);
  assert.equal(saved, 1);
  assert.equal(result.applied.length, 2);
  assert.match(state.body, /Welcome to the new site/);
  assert.match(state.body, /alt="A cup of coffee"/);
});

test('route B on conflict re-reads, re-maps and reports what could not be applied', async () => {
  const units = unitsOf(LIVE_PAGE);
  const h1 = finding(units, 'h1:0', 'teh', 'the');
  const desc = finding(units, 'meta:description', 'teh', 'the');
  const { state, daFetch } = fakeDa(LIVE_PAGE);
  // Another author edits the H1 between our read and our write.
  state.concurrentEdit = (body) => body.replace('Welcome to teh new site', 'Welcome to teh brand new site');
  const result = await applyViaSource({
    daFetch, org: 'o', site: 's', path: '/p', findings: [h1, desc], DOMParserImpl: DOMParser,
  });
  assert.ok(result.ok);
  assert.deepEqual(result.applied.map((a) => a.unitId), ['meta:description']);
  assert.deepEqual(result.skipped.map((s) => [s.finding.unitId, s.reason]), [['h1:0', 'changed']]);
  assert.match(state.body, /Welcome to teh brand new site/, 'the other author\'s edit is kept');
  assert.match(state.body, /demo the checker/);
});

test('route B refuses to write without a version, or when save fails', async () => {
  const units = unitsOf(LIVE_PAGE);
  const f = finding(units, 'h1:0', 'teh', 'the');
  const noEtag = async () => new Response(LIVE_PAGE, { status: 200 });
  const r1 = await applyViaSource({
    daFetch: noEtag, org: 'o', site: 's', path: '/p', findings: [f], DOMParserImpl: DOMParser,
  });
  assert.equal(r1.error, 'NO_VERSION');
  const { daFetch, state } = fakeDa(LIVE_PAGE);
  const r2 = await applyViaSource({
    daFetch, org: 'o', site: 's', path: '/p', findings: [f], saveDocument: async () => ({ ok: false, error: 'timeout' }), DOMParserImpl: DOMParser,
  });
  assert.equal(r2.error, 'SAVE_FAILED');
  assert.equal(state.writes.length, 0);
});

test('route B: a finding in duplicated text is skipped if a copy was inserted before it', async () => {
  const before = '<main><div><p>Intro.</p><div class="cards"><div><div>teh card</div></div></div></div></main>';
  const snapshotUnits = unitsOf(before);
  const f = finding(snapshotUnits, 'cards:0:0', 'teh', 'the');
  // Another author inserted an identical cards block above: id cards:0:0 now points at the copy.
  const now = '<main><div><p>Intro.</p><div class="cards"><div><div>teh card</div></div></div><div class="cards"><div><div>teh card</div></div></div></div></main>';
  const { state, daFetch } = fakeDa(now);
  const result = await applyViaSource({
    daFetch, org: 'o', site: 's', path: '/p', findings: [f], snapshotUnits, DOMParserImpl: DOMParser,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.skipped.map((s) => s.reason), ['ambiguous']);
  assert.equal(state.writes.length, 0);

  // Duplicates that have not moved are still applied.
  const same = fakeDa(now);
  const snap2 = unitsOf(now);
  const f2 = finding(snap2, 'cards.1:0:0', 'teh', 'the');
  const r2 = await applyViaSource({
    daFetch: same.daFetch, org: 'o', site: 's', path: '/p', findings: [f2], snapshotUnits: snap2, DOMParserImpl: DOMParser,
  });
  assert.ok(r2.ok);
  assert.match(same.state.body, /<div>teh card<\/div><\/div><\/div><div class="cards"><div><div>the card/);
});

test('masking: URLs and protected values never reach the provider, offsets still line up', async () => {
  const { maskText, createRemoteProvider } = await import('../tools/copy-check/lib/providers.js');
  const { createCache } = await import('../tools/copy-check/lib/cache.js');
  const text = 'Visit www.frescopa.coffee/shop or order SKU-4410 today.';
  const masked = maskText(text, /SKU-\d+/g);
  assert.equal(masked.length, text.length);
  assert.ok(!masked.includes('frescopa') && !masked.includes('SKU'));
  assert.equal(masked.indexOf('today'), text.indexOf('today'));
  const sent = [];
  const m = new Map();
  const provider = createRemoteProvider({
    broker: { check: async (units) => { sent.push(...units); return { results: [] }; } },
    cache: createCache({ storage: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) } }),
    provider: 'sapling', version: 'v1', language: 'en', scope: 'o/s|api.sapling.ai', protect: /SKU-\d+/g,
  });
  await provider.check(unitsOf(`<main><div><p>${text}</p></div></main>`));
  assert.equal(sent[0].text, masked);
});

test('route A: a finding in a nested block replaces its outermost block, which the host selects', () => {
  const live = '<main><div><div class="accordion" data-block-index="5"><div><div>Q</div><div><p>Intro.</p><div class="cards" data-block-index="30"><div><div>Nested teh card</div></div></div></div></div></div></div></main>';
  const units = unitsOf(live);
  const f = finding(units, 'cards:0:0', 'teh', 'the');
  assert.equal(f.blockOrdinal, 0);
  const out = correctedBlockHtml(live, 0, [f], { DOMParserImpl: DOMParser });
  assert.equal(out.applied.length, 1);
  assert.match(out.html, /^<div class="accordion">/);
  assert.match(out.html, /<div class="cards"><div><div>Nested the card<\/div>/);
});
