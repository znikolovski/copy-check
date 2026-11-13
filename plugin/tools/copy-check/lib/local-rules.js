/**
 * Local rules: free, deterministic checks that no engine does well, mostly for the fields
 * nobody checks (alt text, link text, the meta description).
 */
import { makeFinding } from './findings.js';

const GENERIC_LINK_TEXT = new Set([
  'click here', 'here', 'click', 'read more', 'learn more', 'more', 'link', 'this link',
  'find out more', 'more info', 'more information', 'details', 'go', 'this',
]);
const LONG_SENTENCE_WORDS = 40;
const DOMAINISH = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#].*)?$/i;

function hostOf(href) {
  try {
    return new URL(href, 'https://placeholder.invalid').hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function linkRules(unit) {
  const out = [];
  const text = unit.text.trim().toLowerCase().replace(/[.!?:]+$/, '');
  if (GENERIC_LINK_TEXT.has(text)) {
    out.push(makeFinding(unit, {
      start: 0,
      end: unit.text.length,
      replacement: null,
      type: 'accessibility',
      source: 'local',
      label: 'Link text',
      message: `“${unit.text}” does not say where the link goes. Screen readers list links out of context, so describe the destination.`,
    }));
    return out;
  }
  const domain = unit.text.trim().match(DOMAINISH)?.[1]?.replace(/^www\./, '').toLowerCase();
  const target = hostOf(unit.href);
  if (domain && target && target !== 'placeholder.invalid' && domain !== target && !target.endsWith(`.${domain}`)) {
    out.push(makeFinding(unit, {
      start: 0,
      end: unit.text.length,
      replacement: null,
      type: 'accessibility',
      source: 'local',
      label: 'Link text',
      severity: 'must',
      message: `The link text names ${domain}, but the link goes to ${target}.`,
    }));
  }
  return out;
}

function altRules(unit) {
  if (unit.text) return [];
  return [makeFinding(unit, {
    start: 0,
    end: 0,
    replacement: null,
    type: 'accessibility',
    source: 'local',
    label: 'Alt text',
    severity: 'consider',
    message: unit.hasAltAttr
      ? 'This image has empty alt text. That is right only if the image is decorative.'
      : 'This image has no alt text. Add it unless the image is decorative.',
  })];
}

function repeatedWords(unit) {
  const out = [];
  const re = /(?<![\p{L}\p{N}])([\p{L}\p{N}']+)\s+(\1)(?![\p{L}\p{N}])/giu;
  for (const m of unit.text.matchAll(re)) {
    if (m[1].toLowerCase() !== m[2].toLowerCase() || /^\d+$/.test(m[1])) continue;
    const start = m.index + m[1].length;
    out.push(makeFinding(unit, {
      start,
      end: m.index + m[0].length,
      replacement: '',
      type: 'grammar',
      source: 'local',
      label: 'Repeated word',
      message: `“${m[1]}” appears twice in a row.`,
    }));
  }
  return out;
}

function longSentences(unit) {
  const out = [];
  const re = /[^.!?]+[.!?]*/g;
  for (const m of unit.text.matchAll(re)) {
    const words = m[0].trim().split(/\s+/).filter(Boolean).length;
    if (words <= LONG_SENTENCE_WORDS) continue;
    const lead = m[0].length - m[0].trimStart().length;
    out.push(makeFinding(unit, {
      start: m.index + lead,
      end: m.index + m[0].trimEnd().length,
      replacement: null,
      type: 'readability',
      source: 'local',
      label: 'Readability',
      message: `This sentence has ${words} words. Consider splitting it.`,
    }));
  }
  return out;
}

/** Page-level findings that have no text to point at. */
export function pageRules(units) {
  const description = units.find((u) => u.id === 'meta:description');
  if (description?.text) return [];
  const pseudo = {
    id: 'meta:description', kind: 'meta', field: 'description', text: '', label: 'Meta description', blockOrdinal: null,
  };
  return [makeFinding(pseudo, {
    start: 0,
    end: 0,
    replacement: null,
    type: 'accessibility',
    source: 'local',
    label: 'Meta description',
    severity: 'should',
    message: 'The page has no meta description. Search engines will choose their own text.',
  })];
}

export function checkLocal(units, { onlyUnitIds } = {}) {
  const findings = [];
  units.forEach((unit) => {
    if (onlyUnitIds && !onlyUnitIds.has(unit.id)) return;
    if (unit.kind === 'link') findings.push(...linkRules(unit));
    else if (unit.kind === 'alt') findings.push(...altRules(unit));
    else if (unit.text) {
      findings.push(...repeatedWords(unit));
      if (unit.kind === 'text') findings.push(...longSentences(unit));
    }
  });
  return findings;
}
