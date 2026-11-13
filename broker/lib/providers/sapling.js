'use strict';

/**
 * Sapling grammar and spelling: POST {endpoint}/api/v1/edits.
 * Each edit carries sentence_start plus sentence-relative start/end, so absolute offsets are
 * exact. Only the text is sent: no session id, user id or page path.
 *
 * Calls go through @adobe/aio-lib-core-networking's HttpExponentialBackoff. Network errors and
 * 5xx are retried with exponential backoff; 4xx are not, and a 429 is a spent quota, not a
 * reason to wait.
 */
const { ProviderError, chunkText } = require('./types');

const EDITS_PATH = '/api/v1/edits';
const MAX_RETRIES = 2;
const INITIAL_DELAY_MS = 200;
const VARIETIES = {
  us: 'us-variety', gb: 'gb-variety', uk: 'gb-variety', au: 'au-variety', ca: 'ca-variety',
};

/** Map a BCP 47 tag (en-AU) to Sapling's lang and variety. */
function saplingLanguage(tag) {
  const [base = 'en', region = ''] = String(tag || 'en').toLowerCase().split(/[-_]/);
  if (base === 'auto') return { lang: 'auto' };
  if (base === 'en') return VARIETIES[region] ? { lang: 'en', variety: VARIETIES[region] } : { lang: 'en' };
  if (base === 'zh') return { lang: 'zh', variety: region === 'tw' || region === 'hk' ? 't-variety' : 's-variety' };
  if (base === 'ja') return { lang: 'jp' };
  return { lang: base };
}

function mapType(edit) {
  const general = String(edit.general_error_type || '').toLowerCase();
  const code = String(edit.error_type || '').toUpperCase();
  const label = edit.general_error_type || 'Grammar';
  if (general.includes('spell') || /:(SPELL|ORTH)$/.test(code)) return { type: 'spelling', label: edit.general_error_type || 'Spelling' };
  if (/style|word choice|fluency|clarity|wordiness|tone/.test(general)) return { type: 'style', label };
  return { type: 'grammar', label };
}

/** The default transport: HttpExponentialBackoff, loaded lazily so tests do not need it. */
function defaultRequest(url, init, retryOptions, retryOn) {
  // eslint-disable-next-line global-require
  const { HttpExponentialBackoff } = require('@adobe/aio-lib-core-networking');
  return new HttpExponentialBackoff().exponentialBackoff(url, init, retryOptions, retryOn);
}

const isRefusal = (status) => status === 400 || status === 401 || status === 403 || status === 429;

/**
 * One call with retries. Returns the response and `billable`: how many attempts the provider
 * may have charged for, which is every attempt that got a response other than a refusal.
 * Throws { billable } when no attempt produced a usable response.
 */
async function post(request, endpoint, body) {
  let seen = 0;
  let billable = 0;
  const retryOn = (attempt, error, response) => {
    seen += 1;
    if (response && !isRefusal(response.status)) billable += 1;
    return attempt < MAX_RETRIES && (error !== null || (response.status >= 500 && response.status < 600));
  };
  let resp;
  try {
    resp = await request(`${endpoint}${EDITS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { maxRetries: MAX_RETRIES, initialDelayInMillis: INITIAL_DELAY_MS }, retryOn);
  } catch {
    // Network errors on every attempt. If none got a response, Sapling was never reached.
    throw Object.assign(new ProviderError(billable ? 'unavailable' : 'unreachable', 'Sapling cannot be reached.'), { billable });
  }
  // A transport that does not report attempts made exactly one.
  if (!seen && !isRefusal(resp.status)) billable = 1;
  return { resp, billable };
}

async function failure(resp, billed) {
  const text = await resp.text().catch(() => '');
  if (resp.status === 401 || resp.status === 403 || (resp.status === 400 && /key/i.test(text))) {
    return new ProviderError('invalid-key', 'The Sapling key is wrong or revoked.', billed);
  }
  if (resp.status === 429) return new ProviderError('quota', 'The Sapling quota is spent for this period.', billed);
  if (resp.status >= 500) return new ProviderError('unavailable', `Sapling returned ${resp.status}.`, billed);
  return new ProviderError('bad-response', `Sapling returned ${resp.status}.`, billed);
}

const sapling = {
  name: 'sapling',
  version: 'edits-v1',
  paths: [EDITS_PATH],

  /** @returns {Promise<{ edits: object[], billed: number }>} billed in characters */
  async check(text, {
    endpoint, key, language, request = defaultRequest,
  }) {
    const edits = [];
    let billed = 0;
    for (const chunk of chunkText(text)) {
      let result;
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await post(request, endpoint, { key, text: chunk.text, ...saplingLanguage(language) });
      } catch (e) {
        e.billed = billed + (e.billable || 0) * chunk.text.length;
        throw e;
      }
      billed += result.billable * chunk.text.length;
      // eslint-disable-next-line no-await-in-loop
      if (!result.resp.ok) throw await failure(result.resp, billed);
      // eslint-disable-next-line no-await-in-loop
      const body = await result.resp.json().catch(() => null);
      if (!body || !Array.isArray(body.edits)) throw new ProviderError('bad-response', 'Sapling returned an unexpected body.', billed);
      body.edits.forEach((e) => {
        const start = chunk.offset + e.sentence_start + e.start;
        const end = chunk.offset + e.sentence_start + e.end;
        if (![start, end].every(Number.isInteger) || start < 0 || end < start || end > text.length) return;
        if (typeof e.replacement !== 'string') return;
        edits.push({
          start, end, replacement: e.replacement, ...mapType(e),
        });
      });
    }
    return { edits, billed };
  },

  /** One short call. Resolves with the characters used, or { quotaSpent } for a valid but spent key. */
  async validateKey({ endpoint, key, request = defaultRequest }) {
    const text = 'Copy Check validates this key.';
    let result;
    try {
      result = await post(request, endpoint, { key, text });
    } catch (e) {
      throw new ProviderError('unavailable', e.message, 0);
    }
    if (result.resp.ok) return { chars: result.billable * text.length, quotaSpent: false };
    const error = await failure(result.resp, 0);
    if (error.code === 'quota') return { chars: 0, quotaSpent: true };
    throw error;
  },
};

module.exports = { sapling, saplingLanguage, mapType };
