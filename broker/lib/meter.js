'use strict';

const { HttpError } = require('./http');
const { sha256 } = require('./crypto');

/**
 * The monthly character meter, per-user rate limits, the site-wide findings cache and the site
 * dictionary.
 *
 * aio-lib-state has no atomic increment, so the meter is read, checked and written in one step
 * with no other I/O in between, and characters are reserved before the provider is called and
 * settled afterwards. Two checks that start at the same instant can still both pass, so the cap
 * can be exceeded by at most one request's worth (MAX_REQUEST_CHARS) per concurrent request.
 */

const CACHE_TTL = 30 * 24 * 3600;
const USAGE_TTL = 62 * 24 * 3600;
const RATE_TTL = 120;
const MAX_DICTIONARY = 2000;

const monthOf = (now) => new Date(now).toISOString().slice(0, 7);

function resetDateOf(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

const usageKey = (org, site, month) => `usage-${org}-${site}-${month}`;
const dictionaryPath = (org, site) => `dictionary/${org}/${site}.json`;

async function readUsage(state, org, site, now) {
  return (await state.get(usageKey(org, site, monthOf(now)))) || { chars: 0, requests: 0, dropped: 0 };
}

/** Rate limit per user per minute, on requests and on characters to send. */
async function takeRate(state, userKey, chars, limits, now) {
  const minute = Math.floor(now / 60000);
  const key = `rate-${userKey}-${minute}`;
  const rate = (await state.get(key)) || { requests: 0, chars: 0 };
  if (rate.requests + 1 > limits.requestsPerMinute || (chars > 0 && rate.chars + chars > limits.charsPerMinute)) {
    const retryAfter = 60 - Math.floor((now % 60000) / 1000);
    throw new HttpError(429, 'rate-limited', `Too many checks in a minute. Try again in ${retryAfter} seconds.`, { retryAfter });
  }
  await state.put(key, { requests: rate.requests + 1, chars: rate.chars + chars }, RATE_TTL);
}

/** Reserve characters against the site's monthly budget, or stop with the reset date. */
async function reserve(state, {
  org, site, chars, budget, now,
}) {
  const key = usageKey(org, site, monthOf(now));
  const usage = (await state.get(key)) || { chars: 0, requests: 0, dropped: 0 };
  if (chars > 0 && usage.chars + chars > budget) {
    throw new HttpError(429, 'budget-exhausted', `This site has used its ${Number(budget).toLocaleString('en')} characters for the month.`, {
      resetDate: resetDateOf(now), used: usage.chars, budget,
    });
  }
  const next = { ...usage, chars: usage.chars + chars, requests: usage.requests + 1 };
  await state.put(key, next, USAGE_TTL);
  return next;
}

/**
 * Replace the reservation with what may actually have been billed (less if text never reached
 * the provider, more if retries reached it twice), and record telemetry.
 */
async function settle(state, {
  org, site, reserved, billed, dropped = 0, now,
}) {
  const key = usageKey(org, site, monthOf(now));
  const usage = (await state.get(key)) || { chars: 0, requests: 0, dropped: 0 };
  const delta = billed - reserved;
  const add = Math.max(0, Math.floor(Number(dropped)) || 0);
  if (!delta && !add) return usage;
  const next = { ...usage, chars: Math.max(0, usage.chars + delta), dropped: usage.dropped + add };
  await state.put(key, next, USAGE_TTL);
  return next;
}

/** Characters spent outside a check, such as validating a new key. */
async function record(state, {
  org, site, chars, now,
}) {
  if (!chars) return;
  const key = usageKey(org, site, monthOf(now));
  const usage = (await state.get(key)) || { chars: 0, requests: 0, dropped: 0 };
  await state.put(key, { ...usage, chars: usage.chars + chars }, USAGE_TTL);
}

/**
 * Cache key for one unit. The broker computes it from the text it was sent, scoped to the site,
 * provider, version, endpoint and language, so one author cannot poison another site's results.
 */
function cacheHash({
  org, site, provider, version, endpoint, language, text,
}) {
  return sha256([org, site, provider, version, endpoint, language, text].join('\u0000'));
}

async function cacheGet(state, hash) {
  return state.get(`cache-${hash}`);
}

async function cachePut(state, hash, edits) {
  await state.put(`cache-${hash}`, edits, CACHE_TTL);
}

async function readDictionary(files, org, site) {
  return (await files.readJson(dictionaryPath(org, site))) || [];
}

async function addWord(files, org, site, word) {
  const words = await readDictionary(files, org, site);
  if (words.includes(word)) return words;
  if (words.length >= MAX_DICTIONARY) throw new HttpError(409, 'dictionary-full', 'The site dictionary is full.');
  const next = [...words, word].sort((a, b) => a.localeCompare(b));
  await files.writeJson(dictionaryPath(org, site), next);
  return next;
}

async function removeWord(files, org, site, word) {
  const words = await readDictionary(files, org, site);
  const next = words.filter((w) => w !== word);
  if (next.length !== words.length) await files.writeJson(dictionaryPath(org, site), next);
  return next;
}

module.exports = {
  monthOf,
  resetDateOf,
  readUsage,
  takeRate,
  reserve,
  settle,
  record,
  cacheHash,
  cacheGet,
  cachePut,
  readDictionary,
  addWord,
  removeWord,
  CACHE_TTL,
};
