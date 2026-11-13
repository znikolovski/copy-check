'use strict';

/**
 * Broker-side provider interface. Each engine turns text into unit-relative edits
 * { start, end, replacement, type: 'spelling'|'grammar'|'style', label }, and reports the
 * characters it may have been billed for. Adding WProofreader is a new file here and an entry
 * in PROVIDERS.
 */

/**
 * code: invalid-key | quota | unavailable | unreachable | bad-response
 * unreachable means no attempt reached the provider, so nothing can have been billed.
 */
class ProviderError extends Error {
  constructor(code, message, billed = 0) {
    super(message);
    this.code = code;
    this.billed = billed;
  }
}

/** Split long text near `limit` characters, at a sentence end if possible, keeping offsets. */
function chunkText(text, limit = 4000) {
  const out = [];
  let offset = 0;
  while (text.length - offset > limit) {
    const window = text.slice(offset, offset + limit);
    let cut = -1;
    for (const m of window.matchAll(/[.!?]["')\]]?\s+/g)) cut = m.index + m[0].length;
    if (cut <= 0) cut = window.lastIndexOf(' ') + 1;
    if (cut <= 0) cut = limit;
    out.push({ offset, text: text.slice(offset, offset + cut) });
    offset += cut;
  }
  if (offset < text.length) out.push({ offset, text: text.slice(offset) });
  return out;
}

module.exports = { ProviderError, chunkText };
