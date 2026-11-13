/**
 * Applying corrections.
 *
 * Route A, in place: `actions.sendHTML(blockHtml, { replace: true, expected })` replaces the
 *   selected block in the editor as one transaction (one undo), guarded by the exact live
 *   HTML and block index the findings were mapped against. Used when the finding's block is
 *   the selected block and the host advertises `sendHTMLReplace`.
 * Route B, source write: save, read the DA source with its ETag, apply to that exact text,
 *   write with If-Match. On a conflict, re-read, re-map and report what could not be applied.
 *   The editor reloads through collab. Used for default content, metadata, and page-wide fixes.
 */
import { extractUnits, parseHtml } from './units.js';
import { mapSpan, applyMappedEdit } from './runs.js';
import { isApplicable, nonOverlapping } from './findings.js';
import { DA_ADMIN } from './config.js';

const INSTRUMENTATION = ['data-prose-index', 'data-block-index', 'data-image-index', 'data-image-version',
  'data-cursor-remote', 'data-cursor-remote-color'];

function idsByText(units) {
  const map = new Map();
  units.forEach((u) => {
    if (!u.text) return;
    if (!map.has(u.text)) map.set(u.text, []);
    map.get(u.text).push(u.id);
  });
  return map;
}

/**
 * Apply findings to a parsed document. Each finding is re-validated against the unit text it
 * was computed on; anything that no longer matches or cannot be mapped is skipped, not guessed.
 *
 * Unit ids are positional. When `snapshotUnits` (the units the findings were computed on) is
 * given and the same text appears in several units, a finding is applied only if those
 * duplicates still sit at the same ids, so an inserted or moved copy is never edited instead.
 */
export function applyToDocument(extraction, findings, { snapshotUnits } = {}) {
  const byId = new Map(extraction.units.map((u) => [u.id, u]));
  const nowByText = snapshotUnits ? idsByText(extraction.units) : null;
  const thenByText = snapshotUnits ? idsByText(snapshotUnits) : null;
  const ambiguous = (text) => {
    if (!nowByText) return false;
    const now = nowByText.get(text) ?? [];
    if (now.length < 2) return false;
    return now.join('\u0000') !== (thenByText.get(text) ?? []).join('\u0000');
  };
  const applicable = findings.filter(isApplicable);
  const chosen = nonOverlapping(applicable);
  const chosenIds = new Set(chosen.map((f) => f.id));
  const skipped = applicable.filter((f) => !chosenIds.has(f.id)).map((finding) => ({ finding, reason: 'overlap' }));
  findings.filter((f) => !isApplicable(f)).forEach((finding) => skipped.push({ finding, reason: 'advisory' }));

  const planned = [];
  chosen.forEach((finding) => {
    const unit = byId.get(finding.unitId);
    if (!unit) {
      skipped.push({ finding, reason: 'missing' });
      return;
    }
    if (unit.text !== finding.unitText) {
      skipped.push({ finding, reason: 'changed' });
      return;
    }
    if (ambiguous(unit.text)) {
      skipped.push({ finding, reason: 'ambiguous' });
      return;
    }
    const edit = mapSpan(unit.runs, unit.text.length, finding.start, finding.end);
    if (!edit) {
      skipped.push({ finding, reason: 'unmappable' });
      return;
    }
    planned.push({ finding, edit });
  });

  // Right to left, so earlier offsets in the same node stay valid.
  planned.sort((a, b) => b.finding.start - a.finding.start || b.finding.end - a.finding.end);
  planned.forEach(({ finding, edit }) => applyMappedEdit(edit, finding.replacement));
  return { applied: planned.map((p) => p.finding), skipped };
}

export function stripInstrumentation(el) {
  [el, ...el.querySelectorAll('*')].forEach((node) => {
    INSTRUMENTATION.forEach((name) => node.removeAttribute(name));
  });
  return el;
}

/** The corrected HTML for one block of the live document. */
export function correctedBlockHtml(liveHtml, blockOrdinal, findings, { skipBlocks, DOMParserImpl } = {}) {
  const doc = parseHtml(liveHtml, DOMParserImpl);
  const extraction = extractUnits(doc, { skipBlocks });
  const block = extraction.blocks.find((b) => b.ordinal === blockOrdinal);
  if (!block) return { html: null, applied: [], skipped: findings.map((finding) => ({ finding, reason: 'missing' })) };
  const inBlock = findings.filter((f) => f.blockOrdinal === blockOrdinal);
  const result = applyToDocument(extraction, inBlock);
  findings.filter((f) => f.blockOrdinal !== blockOrdinal)
    .forEach((finding) => result.skipped.push({ finding, reason: 'other-block' }));
  return { html: stripInstrumentation(block.el.cloneNode(true)).outerHTML, ...result };
}

/** Route A: one guarded in-place replacement of the selected block. */
export async function applyInPlace({
  actions, snapshot, findings, skipBlocks, DOMParserImpl,
}) {
  const blockIndex = snapshot?.selection?.blockIndex;
  if (!Number.isInteger(blockIndex)) return { ok: false, error: 'NO_BLOCK', applied: [], skipped: [] };
  const { html, applied, skipped } = correctedBlockHtml(snapshot.html, blockIndex, findings, { skipBlocks, DOMParserImpl });
  if (!html || !applied.length) return { ok: false, error: 'NOTHING_TO_APPLY', applied: [], skipped };
  const result = await actions.sendHTML(html, { replace: true, expected: { html: snapshot.html, blockIndex } });
  if (!result?.ok) {
    return {
      ok: false, error: result?.error || 'REPLACE_FAILED', message: result?.message, applied: [], skipped,
    };
  }
  return {
    ok: true, applied, skipped, live: result,
  };
}

export function sourceUrl({
  daAdmin = DA_ADMIN, org, site, path,
}) {
  let p = path || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.endsWith('/')) p += 'index';
  p = p.replace(/\.html$/, '');
  return `${daAdmin}/source/${org}/${site}${p}.html`;
}

/** Route B: guarded source write. */
export async function applyViaSource({
  daFetch, daAdmin, org, site, path, findings, skipBlocks, saveDocument, DOMParserImpl, snapshotUnits, maxAttempts = 3,
}) {
  if (saveDocument) {
    // Persist the live editor first, so the source we read includes the author's latest edits.
    const saved = await saveDocument();
    if (!saved?.ok) return { ok: false, error: 'SAVE_FAILED', message: saved?.error, applied: [], skipped: [] };
  }
  const url = sourceUrl({
    daAdmin, org, site, path,
  });
  let lastSkipped = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await daFetch(url);
    if (!resp.ok) return { ok: false, error: `READ_${resp.status}`, applied: [], skipped: [] };
    const etag = resp.headers.get('etag');
    if (!etag) return { ok: false, error: 'NO_VERSION', applied: [], skipped: [] };
    // eslint-disable-next-line no-await-in-loop
    const doc = parseHtml(await resp.text(), DOMParserImpl);
    const { applied, skipped } = applyToDocument(extractUnits(doc, { skipBlocks }), findings, { snapshotUnits });
    lastSkipped = skipped;
    if (!applied.length) return { ok: false, error: 'NOTHING_TO_APPLY', applied, skipped };
    const form = new FormData();
    form.set('data', new Blob([doc.body.outerHTML], { type: 'text/html' }));
    // eslint-disable-next-line no-await-in-loop
    const put = await daFetch(url, { method: 'POST', body: form, headers: { 'If-Match': etag } });
    if (put.status === 412) continue; // Someone else wrote first: re-read and re-map.
    if (!put.ok) return { ok: false, error: `WRITE_${put.status}`, applied: [], skipped };
    return { ok: true, applied, skipped };
  }
  return {
    ok: false, error: 'CONFLICT', applied: [], skipped: lastSkipped,
  };
}

export const SKIP_REASONS = {
  overlap: 'overlaps another change',
  advisory: 'has no replacement to apply',
  missing: 'its text is no longer on the page',
  changed: 'the text changed since it was checked',
  unmappable: 'it spans formatting and cannot be applied safely',
  'other-block': 'it is in another block',
  ambiguous: 'the same text now appears elsewhere on the page, so its place is uncertain',
  'not-selected': 'its block could not be selected in the editor',
};
