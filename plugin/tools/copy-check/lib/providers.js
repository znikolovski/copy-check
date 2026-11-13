/**
 * The provider interface. Every engine is normalised to the one Finding model, so the panel,
 * the apply logic and the cache never change when the engine does.
 *
 *   remote provider: the broker, which fronts Sapling (or another engine) and returns
 *                    unit-relative edits { start, end, replacement, type, label, confidence? }
 *   local providers: the site's terms sheet and the built-in local rules (free, always on)
 */
import { unitHash } from './cache.js';
import { makeFinding } from './findings.js';
import { mapSpan } from './runs.js';
import { checkTerms } from './terms.js';
import { checkLocal, pageRules } from './local-rules.js';

export const REMOTE_KINDS = new Set(['text', 'meta', 'alt']);
const MAX_BATCH_CHARS = 40000;
const MAX_BATCH_UNITS = 100;
// URLs, bare domains (frescopa.coffee), email addresses and paths: never corrected.
const URL_TOKEN = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|[^\s@]+@[^\s@]+\.[^\s@]+|(?<!\S)\/[\w./-]+|(?<![\p{L}\p{N}@.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?(?![\p{L}\p{N}])/giu;

export function remoteEligible(unit) {
  return REMOTE_KINDS.has(unit.kind) && !!unit.text;
}

function batches(items) {
  const out = [];
  let current = [];
  let chars = 0;
  items.forEach((item) => {
    if (current.length && (chars + item.text.length > MAX_BATCH_CHARS || current.length >= MAX_BATCH_UNITS)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  });
  if (current.length) out.push(current);
  return out;
}

/**
 * Never send URLs, domains, emails, paths or protected values: replace them with a placeholder
 * of the same length, so the provider's offsets still line up with the unit text.
 */
export function maskText(text, protect) {
  const ranges = protectedRanges(text, protect);
  if (!ranges.length) return text;
  let out = text;
  ranges.forEach(([a, b]) => {
    out = out.slice(0, a) + out.slice(a, b).replace(/\S/g, '0') + out.slice(b);
  });
  return out;
}

/**
 * @param {object} options
 * @param {string} options.scope   site and endpoint identity, so results never cross sites or accounts
 * @param {RegExp|null} [options.protect]
 */
export function createRemoteProvider({
  broker, cache, provider, version, language, scope = '', protect = null,
}) {
  const sendable = (unit) => maskText(unit.text, protect);
  const hashFor = (unit) => unitHash({
    provider, version, language: `${language}\u0000${scope}`, text: sendable(unit),
  });

  return {
    name: provider,
    version,

    /** Characters a check would send, after the local cache. */
    async estimate(units) {
      let total = 0;
      let toSend = 0;
      const seen = new Set();
      await Promise.all(units.filter(remoteEligible).map(async (unit) => {
        const hash = await hashFor(unit);
        total += unit.text.length;
        if (seen.has(hash)) return;
        seen.add(hash);
        if (!cache.get(hash)?.fresh) toSend += unit.text.length;
      }));
      return { total, toSend };
    },

    /**
     * @returns {Promise<{ entries: Map<string, {edits, at, cached, stale}>, error: Error|null,
     *   unchecked: Set<string>, usage?: object }>}
     */
    async check(units, { telemetry } = {}) {
      const eligible = units.filter(remoteEligible);
      const hashes = await Promise.all(eligible.map(hashFor));
      const entries = new Map();
      const stale = new Map();
      const misses = new Map(); // hash -> masked text
      eligible.forEach((unit, i) => {
        const hit = cache.get(hashes[i]);
        if (hit?.fresh) entries.set(unit.id, { edits: hit.edits, at: hit.at, cached: true, stale: false });
        else {
          if (hit) stale.set(hashes[i], hit);
          misses.set(hashes[i], sendable(unit));
        }
      });

      let error = null;
      let usage;
      const fetched = new Map();
      for (const batch of batches([...misses].map(([id, text]) => ({ id, text })))) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const resp = await broker.check(batch, telemetry);
          telemetry = undefined;
          usage = resp.usage ?? usage;
          (resp.results ?? []).forEach((r) => {
            if (!Array.isArray(r.edits)) return;
            const at = cache.set(r.id, r.edits);
            fetched.set(r.id, { edits: r.edits, at, cached: !!r.cached, stale: false });
          });
        } catch (e) {
          error = e;
          break;
        }
      }

      if (error) {
        // The provider is unavailable: every result here comes from a cache, so show its age.
        entries.forEach((entry) => { entry.stale = true; });
      }
      const unchecked = new Set();
      eligible.forEach((unit, i) => {
        if (entries.has(unit.id)) return;
        const got = fetched.get(hashes[i]);
        if (got) {
          entries.set(unit.id, got);
          return;
        }
        const old = stale.get(hashes[i]);
        if (old) entries.set(unit.id, { edits: old.edits, at: old.at, cached: true, stale: true });
        else unchecked.add(unit.id);
      });
      return {
        entries, error, unchecked, usage,
      };
    },
  };
}

export function protectedRanges(text, protect) {
  const ranges = [];
  for (const m of text.matchAll(URL_TOKEN)) ranges.push([m.index, m.index + m[0].length]);
  if (protect) {
    protect.lastIndex = 0;
    for (const m of text.matchAll(protect)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Drop findings that would change a URL, a domain, an email, a path or a protected value. */
export function withoutProtected(findings, protect) {
  const cache = new Map();
  return findings.filter((f) => {
    if (f.source === 'local') return true;
    if (!cache.has(f.unitText)) cache.set(f.unitText, protectedRanges(f.unitText, protect));
    return !cache.get(f.unitText).some(([a, b]) => f.start < b && a < f.end);
  });
}

/**
 * Turn a provider's unit-relative edits into findings. Edits that touch URLs or protected
 * values, or words in the site dictionary, are filtered. Edits whose span cannot be mapped
 * back to one DOM node are dropped and counted, never guessed.
 */
export function remoteFindings(unit, entry, {
  source, protect, ignoreWords = new Set(), onDropped = () => {},
}) {
  const ranges = protectedRanges(unit.text, protect);
  const out = [];
  entry.edits.forEach((edit) => {
    const { start, end } = edit;
    if (!mapSpan(unit.runs, unit.text.length, start, end)) {
      onDropped(edit);
      return;
    }
    if (ranges.some(([a, b]) => start < b && a < end)) return;
    const original = unit.text.slice(start, end);
    if (edit.type === 'spelling' && ignoreWords.has(original.toLowerCase())) return;
    const replacement = typeof edit.replacement === 'string' ? edit.replacement : null;
    out.push(makeFinding(unit, {
      start,
      end,
      replacement,
      type: edit.type || 'grammar',
      source,
      label: edit.label || edit.type,
      confidence: edit.confidence,
      checkedAt: entry.at,
      cachedAt: entry.stale ? entry.at : undefined,
      message: edit.message || describeEdit(edit.label || edit.type, original, replacement),
    }));
  });
  return out;
}

function describeEdit(label, original, replacement) {
  const name = label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Suggestion';
  if (replacement === '') return `${name}: remove “${original}”.`;
  if (!original) return `${name}: insert “${replacement}”.`;
  return `${name}: “${original}” → “${replacement}”.`;
}

/** The free layer: house style terms plus local rules. */
export function localFindings(units, rules, { onlyUnitIds, includePage = false } = {}) {
  const findings = [
    ...checkTerms(units, rules, { onlyUnitIds }),
    ...checkLocal(units, { onlyUnitIds }),
  ];
  if (includePage) findings.push(...pageRules(units));
  return findings;
}
