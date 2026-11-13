'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  ORG, GOOD_KEY, createWorld, makeDeps, call, hash,
} = require('./helpers');

let world;
let deps;
process.env.__OW_NAMESPACE = '28538-copycheck';

beforeEach(async () => {
  world = createWorld();
  deps = await makeDeps(world);
});

const status = (site, token = 'author') => call(deps, 'GET', '/status', { token, query: { org: ORG, site } });
const setKey = (site, key = GOOD_KEY, token = 'admin') => call(deps, 'POST', '/key', { token, body: { org: ORG, site, key } });
const check = (site, texts, token = 'author', extra = {}) => call(deps, 'POST', '/check', {
  token, body: { org: ORG, site, units: texts.map((text) => ({ id: hash(text), text })), ...extra },
});

test('requires a token and access to the site', async () => {
  world.sites.s1 = {};
  assert.equal((await call(deps, 'GET', '/status', { token: null, query: { org: ORG, site: 's1' } })).status, 401);
  assert.equal((await status('s1', 'stranger')).status, 401);
  assert.equal((await status('nosuchsite')).status, 403);
  assert.equal((await status('s1')).status, 200);
});

test('CORS: the plugin\'s static hosting and site origins only', async () => {
  world.sites.s1 = {};
  const ok = await call(deps, 'OPTIONS', '/check', { query: { org: ORG, site: 's1' } });
  assert.equal(ok.headers['Access-Control-Allow-Origin'], 'https://28538-copycheck.adobeio-static.net');
  const site = await call(deps, 'OPTIONS', '/check', { query: { org: ORG, site: 's1' }, origin: 'https://main--s1--acme.aem.page' });
  assert.equal(site.headers['Access-Control-Allow-Origin'], 'https://main--s1--acme.aem.page');
  const other = await status('s1', 'author');
  assert.equal(other.status, 200);
  const evil = await call(deps, 'GET', '/status', { query: { org: ORG, site: 's1' }, origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const wrongSite = await call(deps, 'GET', '/status', { query: { org: ORG, site: 's1' }, origin: 'https://main--other--acme.aem.page' });
  assert.equal(wrongSite.status, 403);
});

test('the key: admins only, validated first, last four shown to admins only', async () => {
  world.sites.s2 = {};
  assert.equal((await setKey('s2', GOOD_KEY, 'author')).status, 403);
  const bad = await setKey('s2', 'badkey-00000000');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid-key');
  assert.equal((await status('s2')).body.configured, false);
  assert.equal((await setKey('s2')).status, 200);
  const admin = (await status('s2', 'admin')).body;
  assert.equal(admin.configured, true);
  assert.equal(admin.keyLast4, '1234');
  assert.equal(admin.endpointHost, 'api.sapling.ai');
  assert.equal(admin.language, 'en-AU');
  const author = (await status('s2')).body;
  assert.equal(author.keyLast4, null);
  assert.ok(!JSON.stringify(author).includes(GOOD_KEY));
});

test('the key is encrypted at rest and bound to its site', async () => {
  world.sites.s3 = {};
  await setKey('s3');
  const stored = deps.files.map.get('keys/acme/s3.json');
  assert.ok(stored && !stored.includes(GOOD_KEY));
  // Copying the record to another site does not make it usable there.
  world.sites.s4 = {};
  deps.files.map.set('keys/acme/s4.json', stored.replace('"site":"s3"', '"site":"s4"'));
  const res = await check('s4', ['Fix teh typo.']);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'broker-misconfigured');
});

test('a rejected rotation leaves the old key working', async () => {
  world.sites.s5 = {};
  await setKey('s5');
  assert.equal((await setKey('s5', 'badkey-00000000')).status, 400);
  assert.equal((await check('s5', ['Fix teh typo.'])).status, 200);
});

test('check before setup says no-key', async () => {
  world.sites.s6 = {};
  const res = await check('s6', ['Hello.']);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'no-key');
});

test('check returns absolute edits and sends only the text, language and key', async () => {
  world.sites.s7 = {};
  await setKey('s7');
  world.saplingCalls = [];
  const text = 'First sentence. Then teh second one.';
  const res = await check('s7', [text]);
  assert.equal(res.status, 200);
  const [edit] = res.body.results[0].edits;
  assert.equal(text.slice(edit.start, edit.end), 'teh');
  assert.equal(edit.type, 'spelling');
  assert.deepEqual(Object.keys(world.saplingCalls[0].body).sort(), ['key', 'lang', 'text', 'variety']);
  assert.equal(world.saplingCalls[0].body.variety, 'au-variety');
  assert.equal(world.saplingCalls[0].url, 'https://api.sapling.ai/api/v1/edits');
});

test('cache: an unchanged unit is never sent twice, and costs nothing', async () => {
  world.sites.s8 = {};
  await setKey('s8');
  world.saplingCalls = [];
  await check('s8', ['A teh paragraph.', 'Another one.']);
  const used = (await status('s8')).body.used;
  const again = await check('s8', ['A teh paragraph.', 'Another one.'], 'admin');
  assert.ok(again.body.results.every((r) => r.cached));
  assert.equal(world.saplingCalls.length, 2);
  assert.equal((await status('s8')).body.used, used);
});

test('the cache is per site', async () => {
  world.sites.a = {};
  world.sites.b = {};
  await setKey('a');
  await setKey('b');
  world.saplingCalls = [];
  await check('a', ['Shared teh text.']);
  await check('b', ['Shared teh text.']);
  assert.equal(world.saplingCalls.length, 2);
});

test('monthly budget: hard stop with the reset date; cached text still works', async () => {
  world.sites.s9 = { budget: '60' };
  await setKey('s9');
  const used = (await status('s9')).body.used;
  const fits = 'x'.repeat(60 - used - 5);
  assert.equal((await check('s9', [fits])).status, 200);
  const over = await check('s9', ['This will not fit.']);
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'budget-exhausted');
  assert.match(over.body.resetDate, /^\d{4}-\d{2}-01$/);
  assert.equal((await check('s9', [fits])).status, 200);
});

test('billing: retried 5xx then success bills both attempts; unreachable bills nothing', async () => {
  world.sites.s10 = {};
  await setKey('s10');
  const before = (await status('s10')).body.used;
  const text = 'Retried teh text.';
  world.sapling.script = [503, 'ok'];
  const res = await check('s10', [text]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await status('s10')).body.used, before + 2 * text.length);

  world.sapling.script = ['network', 'network', 'network'];
  const down = await check('s10', ['Never reached.']);
  assert.equal(down.status, 503);
  assert.equal((await status('s10')).body.used, before + 2 * text.length);
});

test('provider errors: 429 is a spent quota (not retried), a revoked key is reported', async () => {
  world.sites.s11 = {};
  await setKey('s11');
  world.saplingCalls = [];
  world.sapling.mode = 429;
  const quota = await check('s11', ['Quota.']);
  assert.equal(quota.status, 429);
  assert.equal(quota.body.error, 'provider-quota');
  assert.equal(world.saplingCalls.length, 1);
  world.sapling.mode = 401;
  const revoked = await check('s11', ['Revoked.']);
  assert.equal(revoked.status, 502);
  assert.equal(revoked.body.error, 'invalid-key');
});

test('only allow-listed endpoint hosts are called', async () => {
  world.sites.s12 = { endpoint: 'https://evil.example' };
  const res = await setKey('s12');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'endpoint-not-allowed');
  assert.equal(world.saplingCalls.length, 0);
  world.sites.s13 = { endpoint: 'https://sapling.onprem.example' };
  assert.equal((await setKey('s13')).status, 200);
  assert.equal(world.saplingCalls.at(-1).url, 'https://sapling.onprem.example/api/v1/edits');
});

test('rejects ids that are not content hashes, and oversized requests', async () => {
  world.sites.s14 = {};
  await setKey('s14');
  const bad = await call(deps, 'POST', '/check', { body: { org: ORG, site: 's14', units: [{ id: 'cards:2:1', text: 'Hi' }] } });
  assert.equal(bad.status, 400);
  const big = await call(deps, 'POST', '/check', { body: { org: ORG, site: 's14', units: [{ id: 'a'.repeat(64), text: 'x'.repeat(20001) }] } });
  assert.equal(big.status, 400);
  const many = await call(deps, 'POST', '/check', {
    body: { org: ORG, site: 's14', units: Array.from({ length: 4 }, (_, i) => ({ id: hash(String(i)), text: `${i}`.repeat(19000) })) },
  });
  assert.equal(many.status, 413);
});

test('rate limit per user per minute', async () => {
  world.sites.s15 = {};
  const limited = await makeDeps(world, { config: { requestsPerMinute: 2 } });
  await call(limited, 'POST', '/key', { token: 'admin', body: { org: ORG, site: 's15', key: GOOD_KEY } });
  const go = (t) => call(limited, 'POST', '/check', { body: { org: ORG, site: 's15', units: [{ id: hash(t), text: t }] } });
  assert.equal((await go('one')).status, 200);
  assert.equal((await go('two')).status, 200);
  const third = await go('three');
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'rate-limited');
  assert.ok(third.headers['Retry-After']);
});

test('dictionary: authors add words, only admins remove them', async () => {
  world.sites.d1 = {};
  assert.equal((await call(deps, 'POST', '/dictionary', { body: { org: ORG, site: 'd1', word: 'Frescopa' } })).status, 200);
  assert.equal((await call(deps, 'POST', '/dictionary', { body: { org: ORG, site: 'd1', word: 'two words' } })).status, 400);
  assert.deepEqual((await status('d1')).body.dictionary, ['Frescopa']);
  assert.equal((await call(deps, 'DELETE', '/dictionary', { query: { org: ORG, site: 'd1', word: 'Frescopa' } })).status, 403);
  assert.equal((await call(deps, 'DELETE', '/dictionary', { token: 'admin', query: { org: ORG, site: 'd1', word: 'Frescopa' } })).status, 200);
  assert.deepEqual((await status('d1')).body.dictionary, []);
});

test('the key never appears in responses or logs', async () => {
  const lines = [];
  const sink = {
    debug: (l) => lines.push(l), info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l),
  };
  const { createLogger } = require('../lib/http');
  const logged = await makeDeps(world);
  logged.log = createLogger(sink, logged.secrets, 'debug');
  world.sites.l1 = {};
  const responses = [];
  responses.push(await call(logged, 'POST', '/key', { token: 'admin', body: { org: ORG, site: 'l1', key: GOOD_KEY } }));
  world.sapling.mode = 401;
  responses.push(await call(logged, 'POST', '/check', { body: { org: ORG, site: 'l1', units: [{ id: hash('x'), text: 'x' }] } }));
  const everything = JSON.stringify(responses) + lines.join('\n');
  assert.ok(!everything.includes(GOOD_KEY));
});
