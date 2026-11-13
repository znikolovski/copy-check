'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { chunkText } = require('../lib/providers/types');
const { sapling, saplingLanguage, mapType } = require('../lib/providers/sapling');
const { readSettings } = require('../lib/auth');
const { seal, open, loadMasterKey } = require('../lib/crypto');
const { monthOf, resetDateOf } = require('../lib/meter');
const { redact } = require('../lib/http');

test('chunkText keeps offsets and prefers sentence ends', () => {
  const text = `${'a'.repeat(30)}. ${'b'.repeat(30)}. ${'c'.repeat(10)}`;
  const chunks = chunkText(text, 40);
  assert.equal(chunks.map((c) => c.text).join(''), text);
  chunks.forEach((c) => assert.equal(text.slice(c.offset, c.offset + c.text.length), c.text));
  assert.ok(chunks[0].text.endsWith('. '));
  assert.deepEqual(chunkText('x'.repeat(95), 40).map((c) => c.text.length), [40, 40, 15]);
});

test('sapling language and error categories', () => {
  assert.deepEqual(saplingLanguage('en-AU'), { lang: 'en', variety: 'au-variety' });
  assert.deepEqual(saplingLanguage('de-DE'), { lang: 'de' });
  assert.deepEqual(saplingLanguage('ja'), { lang: 'jp' });
  assert.equal(mapType({ error_type: 'R:SPELL', general_error_type: 'Spelling' }).type, 'spelling');
  assert.equal(mapType({ error_type: 'R:ORTH' }).type, 'spelling');
  assert.deepEqual(mapType({ error_type: 'R:PUNCT', general_error_type: 'Punctuation' }), { type: 'grammar', label: 'Punctuation' });
  assert.equal(mapType({ general_error_type: 'Style' }).type, 'style');
});

test('settings come from the copycheck rows; the budget is capped by the broker ceiling', () => {
  const config = { defaultBudget: 5000000, maxBudget: 1000000 };
  const json = { ':type': 'multi-sheet', ':names': ['data'], data: { data: [{ key: 'copycheck.budget', value: '9000000' }, { key: 'copycheck.language', value: 'en-GB' }] } };
  assert.deepEqual(readSettings(json, config), {
    provider: 'sapling', endpoint: 'https://api.sapling.ai', budget: 1000000, language: 'en-GB',
  });
  assert.equal(readSettings(null, { defaultBudget: 5000000, maxBudget: 0 }).budget, 5000000);
  assert.equal(readSettings({ data: [{ key: 'copycheck.budget', value: '0' }] }, config).budget, 0);
});

test('envelope encryption is bound to its site', () => {
  const master = loadMasterKey(crypto.randomBytes(32).toString('base64'));
  const env = seal('my-key', master, 'copy-check:o/a');
  assert.equal(open(env, master, 'copy-check:o/a'), 'my-key');
  assert.throws(() => open(env, master, 'copy-check:o/b'));
  assert.throws(() => loadMasterKey(Buffer.from('short').toString('base64')));
});

test('months reset on the first of the next month, UTC', () => {
  const t = Date.UTC(2026, 11, 31, 23, 0);
  assert.equal(monthOf(t), '2026-12');
  assert.equal(resetDateOf(t), '2027-01-01');
});

test('redact masks known secrets, bearer tokens and key fields', () => {
  const out = redact('key goodkey-0000-1234 and Bearer abcdefghijklmnopqrstuvwxyz and {"key":"zzzzzzzzzz"}', new Set(['goodkey-0000-1234']));
  assert.ok(!out.includes('goodkey') && !out.includes('abcdefghij') && !out.includes('zzzzzzzzzz'));
});

test('real HttpExponentialBackoff: retries a 5xx, not a 429, and bills every attempt that reached Sapling', async () => {
  const outcomes = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls += 1;
      const next = outcomes.shift() ?? 200;
      if (next !== 200) {
        res.writeHead(next);
        res.end('fail');
        return;
      }
      const { text } = JSON.parse(raw);
      const i = text.indexOf('teh');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ edits: i < 0 ? [] : [{ sentence: text, sentence_start: 0, start: i, end: i + 3, replacement: 'the', general_error_type: 'Spelling' }] }));
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    const text = 'Fix teh word.';
    outcomes.push(502);
    const ok = await sapling.check(text, { endpoint, key: 'k', language: 'en' });
    assert.equal(calls, 2);
    assert.equal(ok.billed, 2 * text.length);
    assert.equal(text.slice(ok.edits[0].start, ok.edits[0].end), 'teh');

    calls = 0;
    outcomes.push(429);
    await assert.rejects(sapling.check(text, { endpoint, key: 'k', language: 'en' }), (e) => e.code === 'quota' && e.billed === 0);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});
