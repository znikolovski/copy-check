/**
 * The house style layer: the site's own `terms` sheet, run in the browser.
 * Costs nothing, bills no characters, and keeps working when the provider does not.
 *
 * Sheet columns: term | type | replacement | note
 *   approved       canonical form; flags any other casing or spacing
 *   do not use     flags every use; replacement is optional
 *   use carefully  flags the first use on the page, unless the replacement appears earlier
 */
import { makeFinding } from './findings.js';

const TYPE_ALIASES = {
  approved: 'approved',
  preferred: 'approved',
  'do not use': 'do-not-use',
  'do-not-use': 'do-not-use',
  avoid: 'do-not-use',
  banned: 'do-not-use',
  'use carefully': 'use-carefully',
  'use-carefully': 'use-carefully',
  caution: 'use-carefully',
};

const TERM_UNIT_KINDS = new Set(['text', 'meta', 'alt']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termPattern(term) {
  const body = term.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

/** Turn sheet rows into rules. Rows with an unknown type or no term are ignored. */
export function parseTerms(rows = []) {
  return rows.map((row) => {
    const term = String(row.term ?? row.Term ?? '').trim();
    const rawType = String(row.type ?? row.Type ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const type = TYPE_ALIASES[rawType];
    if (!term || !type) return null;
    return {
      term,
      type,
      replacement: String(row.replacement ?? row.Replacement ?? '').trim(),
      note: String(row.note ?? row.Note ?? '').trim(),
      pattern: termPattern(term),
    };
  }).filter(Boolean);
}

function matches(rule, text) {
  rule.pattern.lastIndex = 0;
  return [...text.matchAll(rule.pattern)];
}

/** Approved terms are the site's vocabulary: an engine must not call them misspelt. */
export function approvedWords(rules) {
  const words = new Set();
  rules.filter((r) => r.type === 'approved').forEach((r) => {
    r.term.split(/\s+/).forEach((w) => words.add(w.toLowerCase()));
  });
  return words;
}

/**
 * Run the rules over units in document order.
 * @param {object[]} units all units of the page (needed for "first use")
 * @param {object[]} rules
 * @param {{ onlyUnitIds?: Set<string> }} [options] limit findings to these units
 */
export function checkTerms(units, rules, { onlyUnitIds } = {}) {
  const findings = [];
  const firstUseDone = new Set();
  const textUnits = units.filter((u) => TERM_UNIT_KINDS.has(u.kind) && u.text);

  textUnits.forEach((unit) => {
    const report = !onlyUnitIds || onlyUnitIds.has(unit.id);
    rules.forEach((rule, ruleIndex) => {
      matches(rule, unit.text).forEach((m) => {
        const start = m.index;
        const end = start + m[0].length;
        if (rule.type === 'approved') {
          if (m[0] === rule.term) return;
          if (!report) return;
          findings.push(makeFinding(unit, {
            start,
            end,
            replacement: rule.term,
            type: 'term',
            source: 'terms',
            label: 'House style',
            message: rule.note || `Your organisation writes this as “${rule.term}”.`,
          }));
          return;
        }
        if (rule.type === 'do-not-use') {
          if (!report) return;
          findings.push(makeFinding(unit, {
            start,
            end,
            replacement: rule.replacement || null,
            type: 'term',
            source: 'terms',
            label: 'House style',
            message: rule.note || `Your organisation does not use “${rule.term}”.`,
          }));
          return;
        }
        // use-carefully: only the first use on the page, unless already spelt out before it.
        if (firstUseDone.has(ruleIndex)) return;
        firstUseDone.add(ruleIndex);
        if (rule.replacement) {
          const before = unit.text.slice(0, start).toLowerCase();
          const spelledOutEarlier = textUnits
            .slice(0, textUnits.indexOf(unit))
            .some((u) => u.text.toLowerCase().includes(rule.replacement.toLowerCase()));
          if (spelledOutEarlier || before.includes(rule.replacement.toLowerCase())) return;
        }
        if (!report) return;
        findings.push(makeFinding(unit, {
          start,
          end,
          replacement: rule.replacement || null,
          type: 'term',
          severity: 'consider',
          source: 'terms',
          label: 'House style',
          message: rule.note || `Use “${rule.term}” with care.`,
        }));
      });
    });
  });
  return findings;
}
