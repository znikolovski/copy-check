/**
 * The one finding model every provider is normalised to.
 *
 * {
 *   id, unitId, start, end,
 *   replacement,   // string; "" means delete; null means advisory (nothing to apply)
 *   type,          // spelling | grammar | style | term | readability | accessibility
 *   severity,      // must | should | consider
 *   message, source ('sapling' | 'terms' | 'local' | other provider name), label,
 *   confidence?, original, unitText, unitLabel, blockOrdinal, checkedAt
 * }
 */
import { PROMINENT_FIELDS } from './units.js';

export const SEVERITIES = ['must', 'should', 'consider'];
const ORDER = { must: 0, should: 1, consider: 2 };

const BASE_SEVERITY = {
  spelling: 'should',
  grammar: 'should',
  style: 'consider',
  readability: 'consider',
  accessibility: 'should',
  term: 'should',
};

export const POLICY_CLASSES = ['spelling', 'grammar', 'style', 'term-case', 'term-wording'];
export const DEFAULT_APPLY_ALL = ['spelling', 'term-case'];
export const SPELLING_CONFIDENCE = 0.8;

export function raise(severity) {
  return SEVERITIES[Math.max(0, ORDER[severity] - 1)];
}

/** Severity by field, not only by error type. */
export function severityFor(type, unit, base = BASE_SEVERITY[type] ?? 'consider') {
  return PROMINENT_FIELDS.has(unit.field) && type !== 'readability' ? raise(base) : base;
}

export function compareSeverity(a, b) {
  return ORDER[a] - ORDER[b];
}

function hashString(value) {
  // FNV-1a: stable, fast ids for findings (not security relevant).
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function makeFinding(unit, raw) {
  const original = unit.text.slice(raw.start, raw.end);
  const finding = {
    unitId: unit.id,
    start: raw.start,
    end: raw.end,
    replacement: raw.replacement ?? null,
    type: raw.type,
    severity: raw.severity ?? severityFor(raw.type, unit),
    message: raw.message,
    source: raw.source,
    label: raw.label ?? raw.type,
    original,
    unitText: unit.text,
    unitLabel: unit.label,
    unitKind: unit.kind,
    blockOrdinal: unit.blockOrdinal ?? null,
    checkedAt: raw.checkedAt ?? Date.now(),
  };
  if (raw.confidence !== undefined) finding.confidence = raw.confidence;
  if (raw.cachedAt !== undefined) finding.cachedAt = raw.cachedAt;
  finding.id = hashString([unit.id, unit.text, raw.start, raw.end, raw.replacement, raw.source, raw.type].join('\u0000'));
  // Ignore keys survive edits elsewhere on the page: they depend only on the words involved.
  finding.ignoreKey = hashString([unit.text, raw.start, raw.end, raw.replacement, raw.source].join('\u0000'));
  return finding;
}

export function isApplicable(finding) {
  return typeof finding.replacement === 'string' && finding.replacement !== finding.original;
}

/** Which apply-all policy class a finding belongs to, or null if it can never be bulk applied. */
export function policyClass(finding) {
  if (!isApplicable(finding)) return null;
  if (finding.type === 'term') {
    const a = finding.original.replace(/\s+/g, ' ').toLowerCase();
    const b = finding.replacement.replace(/\s+/g, ' ').toLowerCase();
    return a === b ? 'term-case' : 'term-wording';
  }
  if (finding.type === 'spelling') {
    const oneWord = (s) => /^\S+$/.test(s);
    const confident = finding.confidence === undefined || finding.confidence >= SPELLING_CONFIDENCE;
    return oneWord(finding.original) && oneWord(finding.replacement) && confident ? 'spelling' : 'grammar';
  }
  if (finding.type === 'grammar') return 'grammar';
  return 'style';
}

export function isSafeForApplyAll(finding, applyAll) {
  const cls = policyClass(finding);
  return !!cls && applyAll.has(cls);
}

/** True when two spans touch the same characters, or are the same insertion point. */
export function overlaps(a, b) {
  if (a.start === b.start && a.end === b.end) return true;
  return a.start < b.end && b.start < a.end;
}

/** Overlapping findings on the same span: keep the house style rule, then the engine, then local. */
const SOURCE_PRIORITY = { terms: 0, local: 2 };

export function dedupe(findings) {
  const sorted = [...findings].sort((a, b) => (SOURCE_PRIORITY[a.source] ?? 1) - (SOURCE_PRIORITY[b.source] ?? 1));
  const kept = [];
  sorted.forEach((f) => {
    if (!kept.some((k) => k.unitId === f.unitId && k.unitText === f.unitText && overlaps(k, f))) kept.push(f);
  });
  return kept;
}

/** Rank by severity, then document order. */
export function rank(findings, unitOrder) {
  return [...findings].sort((a, b) => compareSeverity(a.severity, b.severity)
    || (unitOrder.get(a.unitId) ?? 0) - (unitOrder.get(b.unitId) ?? 0)
    || a.start - b.start);
}

export function countBySeverity(findings) {
  const counts = { must: 0, should: 0, consider: 0 };
  findings.forEach((f) => { counts[f.severity] += 1; });
  return counts;
}

/**
 * After applying `applied` (findings with replacements, possibly several per unit), move the
 * remaining findings of those units onto the new text. Findings that overlapped an applied span,
 * or that were computed against different text, are dropped.
 */
export function rebaseAfterApply(findings, applied) {
  const byUnit = new Map();
  applied.forEach((a) => {
    if (!byUnit.has(a.unitId)) byUnit.set(a.unitId, []);
    byUnit.get(a.unitId).push(a);
  });
  const appliedIds = new Set(applied.map((a) => a.id));
  const out = [];
  findings.forEach((f) => {
    if (appliedIds.has(f.id)) return;
    const edits = byUnit.get(f.unitId);
    if (!edits) {
      out.push(f);
      return;
    }
    if (edits.some((a) => a.unitText !== f.unitText || overlaps(a, f))) return;
    let text = f.unitText;
    let delta = 0;
    [...edits].sort((a, b) => b.start - a.start).forEach((a) => {
      text = text.slice(0, a.start) + a.replacement + text.slice(a.end);
      if (a.end <= f.start) delta += a.replacement.length - (a.end - a.start);
    });
    out.push({ ...f, start: f.start + delta, end: f.end + delta, unitText: text });
  });
  return out;
}

/** Choose a set of non-overlapping findings, so several can be applied to one unit together. */
export function nonOverlapping(findings) {
  const chosen = [];
  [...findings].sort((a, b) => a.unitId.localeCompare(b.unitId) || a.start - b.start).forEach((f) => {
    if (!chosen.some((c) => c.unitId === f.unitId && overlaps(c, f))) chosen.push(f);
  });
  return chosen;
}
