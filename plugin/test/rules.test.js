import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, LIVE_PAGE } from './helpers.js';
import { extractUnits } from '../tools/copy-check/lib/units.js';
import { parseTerms, checkTerms, approvedWords } from '../tools/copy-check/lib/terms.js';
import { checkLocal, pageRules } from '../tools/copy-check/lib/local-rules.js';
import {
  makeFinding, policyClass, isSafeForApplyAll, dedupe, rank, rebaseAfterApply, severityFor, countBySeverity,
} from '../tools/copy-check/lib/findings.js';
import { parseConfig } from '../tools/copy-check/lib/config.js';

const TERMS = parseTerms([
  { term: 'AEM', type: 'use carefully', replacement: 'Adobe Experience Manager', note: 'Spell out on first use' },
  { term: 'best in class', type: 'do not use', replacement: '', note: 'Not an approved claim' },
  { term: 'click here', type: 'do not use', replacement: 'the link text', note: 'Accessibility' },
  { term: 'Edge Delivery Services', type: 'approved', replacement: '', note: 'Capitalise all three words' },
  { term: 'nonsense', type: 'whatever' },
]);

const units = () => extractUnits(parse(LIVE_PAGE)).units;

test('parses the terms sheet and ignores unknown types', () => {
  assert.equal(TERMS.length, 4);
  assert.deepEqual([...approvedWords(TERMS)].sort(), ['delivery', 'edge', 'services']);
});

test('approved terms flag wrong casing with a case-only fix', () => {
  const f = checkTerms(units(), TERMS).find((x) => x.original === 'edge delivery services');
  assert.equal(f.replacement, 'Edge Delivery Services');
  assert.equal(f.source, 'terms');
  assert.equal(policyClass(f), 'term-case');
});

test('do-not-use terms flag every use; no replacement means advisory', () => {
  const found = checkTerms(units(), TERMS);
  const claim = found.find((x) => x.original === 'Best in class');
  assert.equal(claim.replacement, null);
  assert.equal(claim.message, 'Not an approved claim');
  assert.equal(policyClass(claim), null);
  const click = found.find((x) => x.original === 'click here');
  assert.equal(policyClass(click), 'term-wording');
});

test('use-carefully flags the first use only, case-sensitively by word boundary', () => {
  const found = checkTerms(units(), TERMS).filter((x) => x.original.toLowerCase() === 'aem');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'consider');
});

test('use-carefully is quiet when the term is spelt out earlier on the page', () => {
  const doc = parse('<main><div><p>Adobe Experience Manager is great.</p><p>AEM is fast.</p></div></main>');
  assert.equal(checkTerms(extractUnits(doc).units, TERMS).length, 0);
});

test('onlyUnitIds limits findings but first-use still sees the whole page', () => {
  const doc = parse('<main><div><p>AEM one.</p><p>AEM two.</p></div></main>');
  const all = extractUnits(doc).units;
  assert.equal(checkTerms(all, TERMS, { onlyUnitIds: new Set(['p:1']) }).length, 0);
});

test('local rules: generic link text, link mismatch, empty alt, repeated word', () => {
  const found = checkLocal(units());
  const byLabel = (l) => found.filter((f) => f.label === l);
  assert.equal(byLabel('Link text').length, 2);
  const mismatch = byLabel('Link text').find((f) => f.message.includes('example.com'));
  assert.equal(mismatch.severity, 'must');
  assert.equal(byLabel('Alt text').length, 1);
  const repeated = byLabel('Repeated word')[0];
  assert.equal(repeated.original, ' is');
  assert.equal(repeated.replacement, '');
});

test('page rule: missing description', () => {
  const doc = parse('<main><div><p>Hello.</p></div></main>');
  const [f] = pageRules(extractUnits(doc).units);
  assert.equal(f.unitId, 'meta:description');
  assert.equal(pageRules(units()).length, 0);
});

test('severity by field: spelling in H1 or the description is must', () => {
  const all = units();
  const h1 = all.find((u) => u.id === 'h1:0');
  const p = all.find((u) => u.id === 'p:0');
  const desc = all.find((u) => u.id === 'meta:description');
  assert.equal(severityFor('spelling', h1), 'must');
  assert.equal(severityFor('spelling', desc), 'must');
  assert.equal(severityFor('spelling', p), 'should');
  assert.equal(severityFor('style', h1), 'should');
});

test('apply-all policy: confident single-word spelling is safe, grammar is not', () => {
  const p = units().find((u) => u.id === 'p:0');
  const applyAll = new Set(['spelling', 'term-case']);
  const spelling = makeFinding(p, {
    start: 3, end: 10, replacement: 'receive', type: 'spelling', source: 'sapling',
  });
  const unsure = makeFinding(p, {
    start: 3, end: 10, replacement: 'receive', type: 'spelling', source: 'sapling', confidence: 0.4,
  });
  const grammar = makeFinding(p, {
    start: 0, end: 2, replacement: 'Us', type: 'grammar', source: 'sapling',
  });
  assert.ok(isSafeForApplyAll(spelling, applyAll));
  assert.ok(!isSafeForApplyAll(unsure, applyAll));
  assert.ok(!isSafeForApplyAll(grammar, applyAll));
});

test('dedupe keeps the house style finding over the engine on the same span', () => {
  const p = units().find((u) => u.id === 'cards:0:1.1');
  const start = p.text.indexOf('edge');
  const engine = makeFinding(p, {
    start, end: start + 4, replacement: 'Edge', type: 'spelling', source: 'sapling',
  });
  const terms = checkTerms([p], TERMS);
  const kept = dedupe([engine, ...terms]);
  assert.equal(kept.filter((f) => f.source === 'sapling').length, 0);
});

test('rank orders by severity then document order; counts by severity', () => {
  const all = units();
  const order = new Map(all.map((u, i) => [u.id, i]));
  const found = [...checkLocal(all), ...checkTerms(all, TERMS)];
  const ranked = rank(found, order);
  const severities = ranked.map((f) => f.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => ['must', 'should', 'consider'].indexOf(a) - ['must', 'should', 'consider'].indexOf(b)));
  const counts = countBySeverity(found);
  assert.equal(counts.must + counts.should + counts.consider, found.length);
});

test('rebase shifts later findings and drops overlapping ones', () => {
  const unit = { id: 'p:0', text: 'teh cat sat on teh mat', label: 'P', field: 'p', kind: 'text' };
  const a = makeFinding(unit, { start: 0, end: 3, replacement: 'the', type: 'spelling', source: 'sapling' });
  const b = makeFinding(unit, { start: 15, end: 18, replacement: 'the', type: 'spelling', source: 'sapling' });
  const c = makeFinding(unit, { start: 1, end: 2, replacement: 'x', type: 'spelling', source: 'sapling' });
  const lengthen = { ...a, replacement: 'thee' };
  const out = rebaseAfterApply([lengthen, b, c], [lengthen]);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 16);
  assert.equal(out[0].unitText.slice(out[0].start, out[0].end), 'teh');
});

test('config: values, policy and terms from the multi-sheet JSON', () => {
  const config = parseConfig({
    ':type': 'multi-sheet',
    data: {
      data: [
        { key: 'copycheck.budget', value: '5000000' },
        { key: 'copycheck.language', value: 'en-AU' },
        { key: 'copycheck.applyall', value: 'spelling, grammar, bogus' },
        { key: 'copycheck.skipblocks', value: 'Product-Specs, embed' },
        { key: 'copycheck.protect', value: '\\b[A-Z]{2}-\\d{3}\\b' },
        { key: 'other.key', value: 'x' },
      ],
    },
    terms: { data: [{ term: 'AEM', type: 'use carefully', replacement: 'Adobe Experience Manager' }] },
  });
  assert.equal(config.budget, 5000000);
  assert.equal(config.language, 'en-AU');
  assert.deepEqual([...config.applyAll], ['spelling', 'grammar']);
  assert.deepEqual([...config.skipBlocks], ['product-specs', 'embed']);
  assert.ok(config.protect.test('Order AB-123 now'));
  assert.equal(config.terms.length, 1);
  assert.deepEqual([...parseConfig(null).applyAll], ['spelling', 'term-case']);
});

test('broker URL: only the build-stamped meta tag, or a localhost override for local dev', async () => {
  const { brokerUrl } = await import('../tools/copy-check/lib/config.js');
  const { parse } = await import('./helpers.js');
  const page = (content) => parse(`<html><head><meta name="copy-check-broker" content="${content}"></head><body></body></html>`);
  const at = (href) => new URL(href);
  const stamped = 'https://28538-copycheck.adobeio-static.net/api/v1/web/copy-check/api';
  assert.equal(brokerUrl(page(stamped), at('https://28538-copycheck.adobeio-static.net/copy-check.html')), stamped);
  assert.equal(brokerUrl(page(''), at('https://28538-copycheck.adobeio-static.net/copy-check.html')), '');
  assert.equal(brokerUrl(page('http://evil.example/api'), at('https://x.adobeio-static.net/copy-check.html')), '');
  // A ?broker= override is ignored outside localhost, and only points at localhost.
  assert.equal(brokerUrl(page(stamped), at('https://x.adobeio-static.net/copy-check.html?broker=https://evil.example')), stamped);
  assert.equal(brokerUrl(page(''), at('http://localhost:3400/copy-check.html?broker=http://localhost:8790/api')), 'http://localhost:8790/api');
  assert.equal(brokerUrl(page(''), at('http://localhost:3400/copy-check.html?broker=https://evil.example')), '');
});
