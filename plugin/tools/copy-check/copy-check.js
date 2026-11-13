/**
 * Copy Check: a library plugin for Experience Workspace.
 * Checks the copy in the selected block or the whole page, and applies corrections in place.
 */
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  DA_ADMIN, loadConfig, parseConfig, brokerUrl,
} from './lib/config.js';
import { extractUnits, parseHtml } from './lib/units.js';
import { createCache } from './lib/cache.js';
import { createBrokerClient } from './lib/broker-client.js';
import {
  createRemoteProvider, remoteFindings, localFindings, remoteEligible, withoutProtected,
} from './lib/providers.js';
import {
  dedupe, rank, countBySeverity, isApplicable, isSafeForApplyAll, rebaseAfterApply, POLICY_CLASSES,
} from './lib/findings.js';
import { approvedWords } from './lib/terms.js';
import { connectCanvas, watchCanvas } from './lib/canvas.js';
import {
  applyInPlace, applyViaSource, sourceUrl, SKIP_REASONS,
} from './lib/apply.js';
import {
  h, SEVERITY_LABEL, sourceLabel, formatAge, formatDate, formatNumber, snippet, suggestion, countsLine, notice,
} from './lib/ui.js';

const app = document.getElementById('app');
const WORD = /^[\p{L}\p{N}'’.-]{1,64}$/u;
const POLICY_LABEL = {
  spelling: 'Spelling, one confident replacement',
  grammar: 'Grammar',
  style: 'Style and rephrasing',
  'term-case': 'House style, case only',
  'term-wording': 'House style, replacement wording',
};

const state = {
  ctx: null,
  actions: null,
  capabilities: {},
  daAdmin: DA_ADMIN,
  config: parseConfig(null),
  configFound: false,
  isAdmin: false,
  broker: null,
  status: null,
  statusError: null,
  provider: null,
  mode: 'live', // 'live' (editor snapshot) or 'source' (saved page, older hosts)
  live: null,
  page: null,
  unitById: new Map(),
  unitOrder: new Map(),
  // What the last explicit check found, per unit: { text, remote: findings|null, local: findings }.
  // Nothing is recomputed as the author types; a unit whose text changes is dropped and flagged.
  found: new Map(),
  pageChecked: false,
  liveSeq: 0,
  awaitingReload: null, // { texts: Map<unitId, expected text>, timer } after a source write
  selectionWaiters: [], // { ordinal, resolve } waiting for the editor to report a selected block
  canvas: null, // the canvas agent, when the site loads it
  // The live HTML has no page metadata block; the title and description come from the source.
  metaUnits: [],
  metaLoaded: false,
  changed: new Set(),
  lastCheck: null,
  view: 'block',
  busy: '',
  message: null,
  preview: null,
  expanded: new Set(),
  ignored: new Set(),
  dropped: 0,
  droppedUnreported: 0,
  estimate: null,
};

let token = '';
const cache = createCache();
// Local development only: inspect panel state from the console.
if (['localhost', '127.0.0.1'].includes(window.location.hostname)) window.copyCheckState = state;

/* ---------- helpers ---------- */

function daAdminOrigin() {
  const override = new URLSearchParams(window.location.search).get('da-admin');
  return override && ['localhost', '127.0.0.1'].includes(window.location.hostname) ? override : DA_ADMIN;
}

function ignoredKey() {
  return `copycheck:ignored:${state.ctx.org}/${state.ctx.site}`;
}

function loadIgnored() {
  try {
    return new Set(JSON.parse(localStorage.getItem(ignoredKey()) || '[]'));
  } catch {
    return new Set();
  }
}

function saveIgnored() {
  try {
    localStorage.setItem(ignoredKey(), JSON.stringify([...state.ignored].slice(-2000)));
  } catch {
    // Ignoring still works for this session.
  }
}

function dictionaryWords() {
  return new Set([
    ...approvedWords(state.config.terms),
    ...(state.status?.dictionary ?? []).map((w) => w.toLowerCase()),
  ]);
}

function visibleFindings() {
  if (!state.page) return [];
  const words = dictionaryWords();
  const all = [...state.found.values()].flatMap((entry) => [
    ...(entry.remote ?? []).filter((f) => !(f.type === 'spelling' && words.has(f.original.toLowerCase()))),
    ...entry.local,
  ]);
  return rank(withoutProtected(dedupe(all), state.config.protect), state.unitOrder)
    .filter((f) => !state.ignored.has(f.ignoreKey));
}

function isChecked(unitId) {
  return state.found.has(unitId) || state.changed.has(unitId);
}

function selectedBlockIndex() {
  const index = state.live?.selection?.blockIndex;
  return Number.isInteger(index) ? index : null;
}

function canApplyInPlace(findings) {
  const index = selectedBlockIndex();
  return state.mode === 'live'
    && state.capabilities.sendHTMLReplace === 1
    && state.live?.editable !== false
    && index !== null
    && findings.length > 0
    && findings.every((f) => f.blockOrdinal === index);
}

/** True when the host can replace the selected block in place (route A). */
function canReplaceInPlace() {
  return state.mode === 'live' && state.capabilities.sendHTMLReplace === 1 && state.live?.editable !== false;
}

/**
 * How one finding is applied:
 *   inplace  it is in a block: the panel selects that block in the editor (through the canvas
 *            agent, as a click would) and replaces it in place, one undo
 *   source   default content or metadata (or a host without in-place replace): saved page write
 */
function routeFor(finding) {
  if (canApplyInPlace([finding])) return 'inplace';
  if (finding.blockOrdinal !== null && canReplaceInPlace() && !noCanvasAgent()) return 'inplace';
  return 'source';
}

/** True once we know this canvas has no Copy Check agent, so blocks cannot be selected for the author. */
function noCanvasAgent() {
  return state.canvasChecked && !state.canvas;
}

function remoteReady() {
  if (!state.provider) return false;
  if (!state.status) return !!state.offline;
  return !!(state.status.configured && state.status.providerSupported && state.status.endpointAllowed);
}

function setMessage(kind, text) {
  state.message = text ? { kind, text } : null;
}

/* ---------- live document ---------- */

function currentText(unitId) {
  // Page-level findings (no meta description) point at a unit that may not exist: treat it as empty.
  return state.unitById.get(unitId)?.text ?? '';
}

function reconcile() {
  [...state.found].forEach(([id, entry]) => {
    if (currentText(id) !== entry.text) {
      state.found.delete(id);
      state.changed.add(id);
    }
  });
}

function finishReload(message) {
  clearTimeout(state.awaitingReload?.timer);
  state.awaitingReload = null;
  if (state.busy === 'reload') state.busy = '';
  if (message) setMessage('warning', message);
  reconcile();
}

function indexPage() {
  state.unitById = new Map(state.page.units.map((u) => [u.id, u]));
  state.unitOrder = new Map(state.page.units.map((u, i) => [u.id, i]));
}

function setPage(html) {
  state.page = extractUnits(parseHtml(html), { skipBlocks: state.config.skipBlocks });
  // The editor's live preview drops the metadata block: add the title and description read from
  // the saved page, so they can be checked and fixed (they are fixed through the source).
  if (!state.page.units.some((u) => u.kind === 'meta')) state.page.units.push(...state.metaUnits);
  indexPage();
}

/** Reads the page title and description from the saved page. */
async function loadSourceMeta() {
  try {
    const resp = await state.actions.daFetch(sourceUrl({ daAdmin: state.daAdmin, ...state.ctx }));
    if (!resp.ok) return;
    const source = extractUnits(parseHtml(await resp.text()));
    state.metaUnits = source.units.filter((u) => u.kind === 'meta');
    state.metaLoaded = true;
    if (state.page) {
      state.page.units = state.page.units.filter((u) => u.kind !== 'meta' || !u.fromSource);
      if (!state.page.units.some((u) => u.kind === 'meta')) {
        state.metaUnits.forEach((u) => { u.fromSource = true; });
        state.page.units.push(...state.metaUnits);
      }
      indexPage();
    }
  } catch {
    // Metadata checks are skipped this time.
  }
}

function notifySelection() {
  const index = selectedBlockIndex();
  state.selectionWaiters = state.selectionWaiters.filter((w) => {
    if (w.ordinal !== index) return true;
    w.resolve(true);
    return false;
  });
}

function waitForSelection(ordinal, timeoutMs) {
  if (selectedBlockIndex() === ordinal) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiter = { ordinal, resolve };
    state.selectionWaiters.push(waiter);
    setTimeout(() => {
      state.selectionWaiters = state.selectionWaiters.filter((w) => w !== waiter);
      resolve(false);
    }, timeoutMs);
  });
}

function onLive(snapshot) {
  const prev = state.live;
  if (prev && prev.html === snapshot.html && prev.selection?.blockIndex === snapshot.selection?.blockIndex
    && prev.editable === snapshot.editable) return;
  state.live = snapshot;
  notifySelection();
  if (!prev || prev.html !== snapshot.html) {
    setPage(snapshot.html);
    state.estimate = null;
    state.liveSeq += 1;
    if (state.awaitingReload) {
      // After a source write, wait until collab reloads the editor with the corrected text. Until
      // then the editor is stale, and saving it (as another apply would) could undo the write.
      const { texts } = state.awaitingReload;
      if ([...texts].every(([id, text]) => currentText(id) === text)) finishReload();
    } else if (state.busy !== 'apply') {
      // The host broadcasts the new document before it acknowledges a replace; reconcile after the
      // acknowledgement so applied findings are rebased instead of being treated as edits.
      reconcile();
    }
  }
  if (prev && prev.selection?.blockIndex !== snapshot.selection?.blockIndex && state.preview?.scope === 'block') {
    state.preview = null;
  }
  if (state.view !== 'admin') render();
}

async function loadSource() {
  const resp = await state.actions.daFetch(sourceUrl({ daAdmin: state.daAdmin, ...state.ctx }));
  if (!resp.ok) {
    setMessage('error', `The page could not be read (${resp.status}).`);
    render();
    return;
  }
  onLive({ html: await resp.text(), selection: { blockIndex: null } });
}

/* ---------- broker status ---------- */

function lastStatusKey() {
  return `copycheck:provider:${state.ctx.org}/${state.ctx.site}`;
}

function providerFrom(info) {
  return createRemoteProvider({
    broker: state.broker,
    cache,
    provider: info.provider,
    version: info.providerVersion,
    language: info.language,
    scope: `${state.ctx.org}/${state.ctx.site}|${info.endpointHost ?? ''}`,
    protect: state.config.protect,
  });
}

async function refreshStatus() {
  if (!state.broker) return;
  try {
    state.status = await state.broker.status();
    state.statusError = null;
    state.offline = false;
    if (state.status.isAdmin) state.isAdmin = true;
    state.provider = state.status.providerSupported ? providerFrom(state.status) : null;
    try {
      const {
        provider, providerVersion, language, endpointHost,
      } = state.status;
      localStorage.setItem(lastStatusKey(), JSON.stringify({
        provider, providerVersion, language, endpointHost,
      }));
    } catch { /* optional */ }
  } catch (e) {
    state.status = null;
    state.statusError = e;
    state.provider = null;
    state.offline = false;
    // The broker is down: keep serving cached findings for the last known provider.
    if (e.code === 'unavailable' || e.status >= 500) {
      try {
        const last = JSON.parse(localStorage.getItem(lastStatusKey()) || 'null');
        if (last?.provider) {
          state.provider = providerFrom(last);
          state.offline = true;
        }
      } catch { /* no fallback */ }
    }
  }
}

/* ---------- checking ---------- */

function groupByUnit(findings) {
  const map = new Map();
  findings.forEach((f) => {
    if (!map.has(f.unitId)) map.set(f.unitId, []);
    map.get(f.unitId).push(f);
  });
  return map;
}

async function runCheck(scope) {
  if (!state.page || state.busy) return;
  if (scope === 'page' && state.mode === 'live') {
    state.busy = scope;
    render();
    await loadSourceMeta();
    state.busy = '';
  }
  const index = selectedBlockIndex();
  const units = scope === 'page' ? state.page.units : state.page.units.filter((u) => u.blockOrdinal === index);
  if (scope === 'page') state.pageChecked = true;
  state.busy = scope;
  state.preview = null;
  setMessage(null);
  state.lastCheck = {
    scope, at: Date.now(), error: null, unchecked: new Set(), staleAt: null,
  };

  // The free layer, computed once now, on request.
  const ids = new Set(units.map((u) => u.id));
  const local = groupByUnit(localFindings(state.page.units, state.config.terms, {
    onlyUnitIds: ids, includePage: scope === 'page' && state.metaLoaded,
  }));
  units.forEach((u) => {
    state.found.set(u.id, { text: u.text, remote: null, local: local.get(u.id) ?? [] });
    state.changed.delete(u.id);
  });
  if (scope === 'page') {
    state.found.set('meta:description', {
      ...(state.found.get('meta:description') ?? { remote: null }),
      text: currentText('meta:description'),
      local: local.get('meta:description') ?? [],
    });
  }
  render();

  if (state.broker && !state.status) await refreshStatus();
  if (remoteReady()) {
    const telemetry = state.droppedUnreported ? { dropped: state.droppedUnreported } : undefined;
    const result = await state.provider.check(units, { telemetry });
    if (!result.error) state.droppedUnreported = 0;
    units.filter(remoteEligible).forEach((unit) => {
      const entry = result.entries.get(unit.id);
      const stored = state.found.get(unit.id);
      // The author kept typing while the check ran: these results describe old text.
      if (!entry || !stored || stored.text !== unit.text || currentText(unit.id) !== unit.text) return;
      stored.remote = remoteFindings(unit, entry, {
        source: state.provider.name,
        protect: state.config.protect,
        onDropped: () => {
          if (entry.cached) return;
          state.dropped += 1;
          state.droppedUnreported += 1;
        },
      });
      if (entry.stale) state.lastCheck.staleAt = Math.min(state.lastCheck.staleAt ?? entry.at, entry.at);
    });
    state.lastCheck.error = result.error;
    state.lastCheck.unchecked = result.unchecked;
    if (result.usage && state.status) state.status.used = result.usage.used;
    if (result.error?.code === 'no-key' || result.error?.code === 'invalid-key') await refreshStatus();
  }
  state.busy = '';
  render();
}

/* ---------- applying ---------- */

function applyTextEdits(text, edits) {
  return [...edits].sort((a, b) => b.start - a.start)
    .reduce((t, e) => t.slice(0, e.start) + e.replacement + t.slice(e.end), text);
}

function afterApplied(applied) {
  const byUnit = new Map();
  applied.forEach((f) => {
    if (!byUnit.has(f.unitId)) byUnit.set(f.unitId, []);
    byUnit.get(f.unitId).push(f);
  });
  const expected = new Map();
  byUnit.forEach((edits, unitId) => {
    const text = applyTextEdits(edits[0].unitText, edits);
    expected.set(unitId, text);
    const entry = state.found.get(unitId);
    if (!entry) return;
    entry.remote = entry.remote && rebaseAfterApply(entry.remote, edits);
    entry.local = rebaseAfterApply(entry.local, edits);
    entry.text = text;
  });
  return expected;
}

const APPLY_ERRORS = {
  STALE_LIVE: 'The page changed while applying, so nothing was changed. Try again.',
  WRONG_SELECTION: 'The cursor moved to another block, so nothing was changed. Click back into the block and try again.',
  READ_ONLY: 'You cannot edit this page.',
  NO_TARGET: 'Place the cursor inside the block first.',
  CROSS_TARGET: 'The selection spans more than one block. Click inside one block and try again.',
  INVALID_HTML: 'The editor rejected the change. Nothing was changed.',
  timeout: 'The editor did not answer. Check the page before trying again.',
  disconnected: 'The connection to the editor was lost. Reopen the panel.',
  SAVE_FAILED: 'The page could not be saved first, so nothing was written.',
  NO_VERSION: 'The saved page has no version to guard the write, so nothing was written.',
  CONFLICT: 'Someone else kept editing the page, so the change was not written. Check again.',
  NOTHING_TO_APPLY: 'Nothing could be applied.',
  NOT_SELECTED: 'The block could not be selected in the editor. Click into it and apply again.',
};

function describeSkipped(skipped) {
  const relevant = skipped.filter((s) => s.reason !== 'advisory');
  if (!relevant.length) return '';
  const reasons = [...new Set(relevant.map((s) => SKIP_REASONS[s.reason] ?? s.reason))];
  return ` ${relevant.length} not applied: ${reasons.join('; ')}.`;
}

/**
 * Selects a block in the editor, as the author's click would: the canvas agent presses on the
 * block in the canvas, and the editor reports the new selection. Resolves true once it has.
 */
async function selectInEditor(ordinal) {
  if (selectedBlockIndex() === ordinal) return true;
  const block = state.page.blocks.find((b) => b.ordinal === ordinal);
  if (!block || block.proseIndex === null) return false;
  if (!state.canvas) state.canvas = await connectCanvas(state.ctx);
  state.canvasChecked = true;
  if (!state.canvas) return false;
  for (const force of [false, true]) {
    const selected = waitForSelection(ordinal, 1500);
    try {
      // eslint-disable-next-line no-await-in-loop
      await state.canvas.selectBlock(block.proseIndex, { force });
    } catch (e) {
      if (e.phase === 'connect') state.canvas = null;
      return false;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await selected) return true;
  }
  return false;
}

/** Route A for the findings of one block. Retries once if the page changed under it. */
async function applyBlockInPlace(ordinal, list) {
  if (!(await selectInEditor(ordinal))) {
    return { ok: false, error: 'NOT_SELECTED', applied: [], skipped: list.map((finding) => ({ finding, reason: 'not-selected' })) };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const seq = state.liveSeq;
    // eslint-disable-next-line no-await-in-loop
    const result = await applyInPlace({
      actions: state.actions, snapshot: state.live, findings: list, skipBlocks: state.config.skipBlocks,
    });
    if (result.ok) {
      afterApplied(result.applied);
      // Only use the acknowledgement's snapshot if no newer broadcast arrived in the meantime.
      if (state.liveSeq === seq && typeof result.live?.html === 'string') {
        onLive({ html: result.live.html, selection: result.live.selection, editable: result.live.editable });
      }
      reconcile();
      return result;
    }
    // STALE_LIVE changed nothing: wait for the fresh snapshot, then try again with re-validated findings.
    if (result.error !== 'STALE_LIVE' || attempt) return result;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 400); });
  }
  return { ok: false, error: 'STALE_LIVE', applied: [], skipped: [] };
}

async function applyFindings(findings) {
  if (state.busy) return;
  state.busy = 'apply';
  state.preview = null;
  setMessage(null);
  render();

  // Block findings go straight into their block when the editor can replace in place and the
  // block is selected, or can be selected through the canvas agent. Everything else (default
  // content, metadata, or a block that cannot be selected) goes through one source write.
  if (canReplaceInPlace() && !state.canvas && findings.some((f) => f.blockOrdinal !== null && f.blockOrdinal !== selectedBlockIndex())) {
    state.canvas = await connectCanvas(state.ctx);
    state.canvasChecked = true;
  }
  const byBlock = new Map();
  const rest = [];
  findings.forEach((f) => {
    const direct = canReplaceInPlace() && f.blockOrdinal !== null
      && (f.blockOrdinal === selectedBlockIndex() || state.canvas);
    if (!direct) {
      rest.push(f);
      return;
    }
    if (!byBlock.has(f.blockOrdinal)) byBlock.set(f.blockOrdinal, []);
    byBlock.get(f.blockOrdinal).push(f);
  });

  const applied = [];
  const skipped = [];
  const errors = [];
  for (const [ordinal, list] of byBlock) {
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await applyBlockInPlace(ordinal, list);
    } catch (e) {
      result = { ok: false, error: 'EXCEPTION', message: String(e?.message ?? e), skipped: [] };
    }
    applied.push(...(result.applied ?? []));
    skipped.push(...(result.skipped ?? []));
    if (!result.ok) errors.push(result);
  }

  let wroteSource = false;
  if (rest.length) {
    let result;
    try {
      result = await applyViaSource({
        daFetch: state.actions.daFetch,
        daAdmin: state.daAdmin,
        ...state.ctx,
        findings: rest,
        skipBlocks: state.config.skipBlocks,
        snapshotUnits: state.page.units,
        saveDocument: state.mode === 'live' && state.actions.saveDocument ? () => state.actions.saveDocument() : undefined,
      });
    } catch (e) {
      result = { ok: false, error: 'EXCEPTION', message: String(e?.message ?? e), skipped: [] };
    }
    skipped.push(...(result.skipped ?? []));
    if (result.ok) {
      wroteSource = true;
      applied.push(...result.applied);
      const expected = afterApplied(result.applied);
      if (state.mode === 'source') {
        await loadSource();
      } else {
        // Metadata never appears in the live document: re-read it from the source just written.
        if (result.applied.some((f) => f.unitKind === 'meta')) await loadSourceMeta();
        // The editor still shows the old text until collab reloads it. Block further applies until then.
        state.busy = 'reload';
        state.awaitingReload = {
          texts: expected,
          timer: setTimeout(() => {
            finishReload('The editor has not reloaded yet. Reload the page before applying more fixes.');
            render();
          }, 20000),
        };
        if ([...expected].every(([id, text]) => currentText(id) === text)) finishReload();
      }
    } else {
      errors.push(result);
    }
  }
  if (state.busy === 'apply') state.busy = '';
  if (!wroteSource && state.page) reconcile();

  const n = applied.length;
  const parts = [];
  if (n) {
    parts.push(`Applied ${n} change${n === 1 ? '' : 's'}.`);
    parts.push(wroteSource ? 'The page was saved; the editor reloads with the change.' : 'Undo works as usual.');
  }
  errors.forEach((e) => {
    parts.push(APPLY_ERRORS[e.error] ?? `A change was not applied (${e.message || e.error}).`);
  });
  setMessage(errors.length ? (n ? 'warning' : 'error') : 'success', `${parts.join(' ')}${describeSkipped(skipped)}`);
  render();
}

function ignore(finding) {
  state.ignored.add(finding.ignoreKey);
  saveIgnored();
  render();
}

async function addToDictionary(finding) {
  const word = finding.original.trim();
  if (!WORD.test(word) || !state.broker) return;
  try {
    await state.broker.addWord(word);
    state.status.dictionary = [...new Set([...(state.status.dictionary ?? []), word])].sort();
    setMessage('success', `“${word}” was added to the site dictionary.`);
  } catch (e) {
    setMessage('error', e.message);
  }
  render();
}

/* ---------- rendering: shared ---------- */

function remoteStatusNotice() {
  const still = ' House style and built-in checks still run.';
  const staleAt = state.lastCheck?.staleAt;
  const stale = staleAt ? ` Showing findings from a check ${formatAge(Date.now() - staleAt)}.` : '';
  if (!state.broker) {
    return notice('info', `Spelling and grammar are off: this copy of the plugin has no broker.${still}`);
  }
  if (state.statusError) {
    const e = state.statusError;
    const text = {
      'not-enabled': 'This site has not enabled Copy Check on its broker.',
      'not-allowed': 'You do not have access to this site.',
      'not-signed-in': 'Your session has expired. Reopen the panel.',
    }[e.code] ?? 'The copy check service is unavailable.';
    const retry = async () => {
      await refreshStatus();
      if (state.lastCheck && !state.statusError) await runCheck(state.lastCheck.scope);
      else render();
    };
    return notice('warning', `${text}${still}${stale} `, h('button', { class: 'cc-link', onClick: retry }, 'Retry'));
  }
  if (!state.status) return null;
  if (!state.status.configured) {
    return notice('info', `Spelling and grammar are not set up yet.${still} `, state.isAdmin
      ? h('button', { class: 'cc-link', onClick: () => { state.view = 'admin'; render(); } }, 'Open settings')
      : 'Ask a site administrator to set it up.');
  }
  if (!state.status.providerSupported || !state.status.endpointAllowed) {
    return notice('warning', `The configured provider or endpoint is not allowed by the broker.${still}`);
  }
  const last = state.lastCheck;
  if (!last) return null;
  const err = last.error;
  if (err) {
    const retry = h('button', { class: 'cc-link', onClick: () => runCheck(last.scope) }, 'Retry');
    if (err.code === 'budget-exhausted') {
      return notice('warning', `This site has used its characters for the month. Spelling and grammar resume on ${formatDate(err.resetDate)}.${still}${stale}`);
    }
    if (err.code === 'provider-quota') return notice('warning', `The Sapling quota is spent for this period.${still}${stale}`);
    if (err.code === 'rate-limited') return notice('warning', `${err.message}${stale} `, retry);
    if (err.code === 'invalid-key') return notice('error', `The Sapling key was rejected. ${state.isAdmin ? 'Set a new one in settings.' : 'Ask a site administrator to set a new one.'}${still}`);
    return notice('warning', `Spelling and grammar are unavailable right now.${still}${stale} `, retry);
  }
  if (last.unchecked.size) {
    return notice('warning', `${last.unchecked.size} piece${last.unchecked.size === 1 ? '' : 's'} of copy could not be checked. `, h('button', { class: 'cc-link', onClick: () => runCheck(last.scope) }, 'Retry'));
  }
  return null;
}

function findingCard(f) {
  const applicable = isApplicable(f);
  const route = applicable ? routeFor(f) : null;
  const busy = !!state.busy;
  // Without the canvas agent a block finding is written through the source, unless the author
  // clicks into the block first, which makes it an in-place fix.
  const needsClick = route === 'source' && f.blockOrdinal !== null && canReplaceInPlace();
  const blockLabel = needsClick ? state.page.blocks.find((b) => b.ordinal === f.blockOrdinal)?.label : null;
  const canDictionary = f.type === 'spelling' && f.source !== 'terms' && f.source !== 'local' && state.broker && WORD.test(f.original.trim());
  return h(
    'article',
    { class: `cc-finding cc-${f.severity}` },
    h(
      'header',
      {},
      h('span', { class: 'cc-sev' }, SEVERITY_LABEL[f.severity]),
      h('span', { class: `cc-source cc-source-${f.source}` }, sourceLabel(f)),
    ),
    h('p', { class: 'cc-where' }, f.unitLabel),
    snippet(f),
    suggestion(f),
    h('p', { class: 'cc-message' }, f.message),
    f.cachedAt ? h('p', { class: 'cc-age' }, `From a check ${formatAge(Date.now() - f.cachedAt)}`) : null,
    h(
      'div',
      { class: 'cc-actions' },
      route ? h('button', {
        class: 'cc-btn cc-primary',
        disabled: busy,
        title: route === 'inplace' ? 'Selects the block and fixes it in the editor. Undo works as usual.' : 'Saves the page, writes the fix, and the editor reloads.',
        onClick: () => applyFindings([f]),
      }, route === 'inplace' ? 'Apply' : 'Apply and reload') : null,
      h('button', { class: 'cc-btn', disabled: busy, onClick: () => ignore(f) }, 'Ignore'),
      canDictionary ? h('button', { class: 'cc-btn', disabled: busy, onClick: () => addToDictionary(f) }, 'Add to dictionary') : null,
    ),
    needsClick
      ? h('p', { class: 'cc-hint cc-select-block' }, `Or click into ${blockLabel ?? 'the block'} in the editor first, to fix it in place without a reload.`)
      : null,
  );
}

function applyAllControls(scope, findings) {
  const safe = findings.filter((f) => isSafeForApplyAll(f, state.config.applyAll));
  if (!safe.length) return null;
  if (state.preview?.scope === scope) {
    const direct = (f) => f.blockOrdinal !== null && canReplaceInPlace()
      && (f.blockOrdinal === selectedBlockIndex() || !noCanvasAgent());
    const inBlocks = state.preview.findings.filter(direct);
    const blockCount = new Set(inBlocks.map((f) => f.blockOrdinal)).size;
    const viaSource = inBlocks.length < state.preview.findings.length;
    let how;
    if (!viaSource && blockCount === 1) how = 'One change in the editor, so one undo reverts all of it.';
    else if (!viaSource) how = `Each of the ${blockCount} blocks is changed in the editor; undo reverts one block at a time.`;
    else if (inBlocks.length) how = 'Blocks are changed in the editor. The other copy is saved to the page, and the editor reloads.';
    else how = 'One save of the page, so the page history can restore the previous version. The editor reloads.';
    return h(
      'section',
      { class: 'cc-preview', 'aria-label': 'Changes to apply' },
      h('h3', {}, `Apply ${state.preview.findings.length} change${state.preview.findings.length === 1 ? '' : 's'}?`),
      h('ul', {}, state.preview.findings.map((f) => h(
        'li',
        {},
        h('span', { class: 'cc-del' }, f.original || '‸'),
        ' → ',
        h('span', { class: 'cc-ins' }, f.replacement || '(remove)'),
        h('span', { class: 'cc-where' }, ` ${f.unitLabel}`),
      ))),
      h('p', { class: 'cc-hint' }, how),
      h(
        'div',
        { class: 'cc-actions' },
        h('button', { class: 'cc-btn cc-primary', disabled: !!state.busy, onClick: () => applyFindings(state.preview.findings) }, 'Apply these'),
        h('button', { class: 'cc-btn', onClick: () => { state.preview = null; render(); } }, 'Cancel'),
      ),
    );
  }
  return h('button', {
    class: 'cc-btn cc-secondary',
    disabled: !!state.busy,
    onClick: () => { state.preview = { scope, findings: safe }; render(); },
  }, `Apply all safe fixes (${safe.length})`);
}

function changedNotice(unitIds) {
  const n = unitIds.filter((id) => state.changed.has(id)).length;
  if (!n) return null;
  return notice('info', `${n} piece${n === 1 ? '' : 's'} of copy changed since the check. Check again to include them.`);
}

/* ---------- rendering: views ---------- */

function renderBlockView() {
  if (state.mode === 'source') {
    return [notice('info', 'This editor does not share the live document, so blocks cannot be followed. Use the page view.')];
  }
  const index = selectedBlockIndex();
  if (index === null) {
    return [
      h('p', { class: 'cc-empty' }, 'Place the cursor in a block to check it. Default content, the page title and the meta description are checked in the page view.'),
      h('button', { class: 'cc-btn cc-primary', disabled: !!state.busy, onClick: () => { state.view = 'page'; runCheck('page'); } }, 'Check the page'),
    ];
  }
  const block = state.page.blocks.find((b) => b.ordinal === index);
  if (!block) {
    return [
      h('p', { class: 'cc-empty' }, 'Copy Check cannot match the selected block to the page. Check the page instead.'),
      h('button', { class: 'cc-btn cc-primary', disabled: !!state.busy, onClick: () => { state.view = 'page'; runCheck('page'); } }, 'Check the page'),
    ];
  }
  const unitIds = state.page.units.filter((u) => u.blockOrdinal === index).map((u) => u.id);
  const checked = unitIds.some(isChecked);
  const findings = visibleFindings().filter((f) => f.blockOrdinal === index);
  const out = [
    h(
      'div',
      { class: 'cc-target' },
      h('h2', {}, block.label),
      h('button', {
        class: 'cc-btn cc-primary', disabled: !!state.busy || block.skipped, onClick: () => runCheck('block'),
      }, state.busy === 'block' ? 'Checking…' : 'Check block'),
    ),
  ];
  if (block.skipped) out.push(notice('info', 'This block is not checked: its values belong to another system (copycheck.skipblocks).'));
  if (!checked) {
    out.push(h('p', { class: 'cc-hint' }, 'Nothing is checked as you type. Check when you are ready.'));
    return out;
  }
  out.push(changedNotice(unitIds));
  out.push(applyAllControls('block', findings));
  out.push(findings.length
    ? h('div', { class: 'cc-list' }, findings.map(findingCard))
    : h('p', { class: 'cc-empty cc-clear' }, 'No findings in this block.'));
  return out;
}

/**
 * Page view groups, in page order: each block, and each run of default content between blocks.
 * @returns {Map<string, { key, block, first }>} and unit id -> group key
 */
function pageGroups() {
  const groups = new Map();
  const unitGroup = new Map();
  let run = 0;
  let lastWasBlock = true;
  state.page.units.forEach((u) => {
    if (u.kind === 'meta') return;
    let key;
    if (u.blockOrdinal !== null && u.blockOrdinal !== undefined) {
      key = `block:${u.blockOrdinal}`;
      lastWasBlock = true;
    } else {
      if (lastWasBlock || groups.get(`run:${run}`)?.first.sectionIndex !== u.sectionIndex) run += 1;
      key = `run:${run}`;
      lastWasBlock = false;
    }
    if (!groups.has(key)) groups.set(key, { key, first: u, block: key.startsWith('block:') ? state.page.blocks.find((b) => b.ordinal === u.blockOrdinal) : null });
    unitGroup.set(u.id, key);
  });
  return { groups, unitGroup };
}

function runTitle(first) {
  const text = state.page.units.find((u) => u.kind === 'text' && u.sectionIndex === first.sectionIndex
    && (state.unitOrder.get(u.id) ?? 0) >= (state.unitOrder.get(first.id) ?? 0))?.text ?? first.text;
  const words = text.length > 36 ? `${text.slice(0, 36).replace(/\s+\S*$/, '')}…` : text;
  return `Default content: “${words}”`;
}

function expandable(key, title, counts, body, extra) {
  const open = state.expanded.has(key);
  return h(
    'li',
    { class: `cc-group${open ? ' cc-open' : ''}` },
    h('button', {
      class: 'cc-group-head',
      'aria-expanded': open ? 'true' : 'false',
      onClick: () => {
        if (open) state.expanded.delete(key);
        else state.expanded.add(key);
        render();
      },
    }, h('span', { class: 'cc-group-title' }, title), countsLine(counts)),
    extra,
    open ? body() : null,
  );
}

function renderPageView() {
  const findings = visibleFindings();
  const est = state.estimate;
  if (remoteReady() && (!est || est.html !== state.live.html) && !state.estimating) {
    state.estimating = true;
    const html = state.live.html;
    state.provider.estimate(state.page.units).then((e) => {
      state.estimate = { html, ...e };
      state.estimating = false;
      if (state.view === 'page') render();
    });
  }
  const estimateLine = remoteReady() && est
    ? h('p', { class: 'cc-hint' }, est.toSend
      ? `About ${formatNumber(est.toSend)} characters to send (${formatNumber(est.total - est.toSend)} already checked).`
      : 'Everything on this page is already checked, so this costs nothing.')
    : null;
  const out = [
    h(
      'div',
      { class: 'cc-target' },
      h('h2', {}, 'This page'),
      h('button', { class: 'cc-btn cc-primary', disabled: !!state.busy, onClick: () => runCheck('page') }, state.busy === 'page' ? 'Checking…' : 'Check page'),
    ),
    estimateLine,
  ];
  if (!state.pageChecked) {
    out.push(h('p', { class: 'cc-hint' }, 'Checks every block, the page title, the meta description, alt text and link text.'));
    return out;
  }

  const counts = countBySeverity(findings);
  const toFix = counts.must + counts.should;
  out.push(changedNotice(state.page.units.map((u) => u.id)));
  out.push(h(
    'p',
    { class: 'cc-summary' },
    toFix ? `${toFix} thing${toFix === 1 ? '' : 's'} to fix` : 'Nothing to fix',
    counts.consider ? `, ${counts.consider} to consider.` : '.',
  ));

  // The fields authors forget.
  const forUnits = (pred) => findings.filter((f) => pred(state.unitById.get(f.unitId) ?? { id: f.unitId, kind: f.unitKind }));
  const titleF = forUnits((u) => u.id === 'meta:title');
  const descF = forUnits((u) => u.id === 'meta:description');
  const altF = forUnits((u) => u.kind === 'alt');
  const images = state.page.units.filter((u) => u.kind === 'alt');
  const missingAlt = images.filter((u) => !u.text).length;
  const hasTitle = state.unitById.has('meta:title');
  out.push(h('h3', { class: 'cc-section-title' }, 'Fields authors forget'));
  out.push(h(
    'ul',
    { class: 'cc-groups' },
    expandable('field:title', 'Page title', countBySeverity(titleF), () => h('div', { class: 'cc-list' }, titleF.map(findingCard)),
      hasTitle ? null : h('p', { class: 'cc-hint' }, 'No title in the metadata block: the first heading is used.')),
    expandable('field:description', 'Meta description', countBySeverity(descF), () => h('div', { class: 'cc-list' }, descF.map(findingCard))),
    expandable('field:alt', `Alt text (${images.length} image${images.length === 1 ? '' : 's'}${missingAlt ? `, ${missingAlt} without` : ''})`,
      countBySeverity(altF), () => h('div', { class: 'cc-list' }, altF.map(findingCard))),
  ));

  // Every block and every run of default content, in page order.
  const { groups, unitGroup } = pageGroups();
  out.push(h('h3', { class: 'cc-section-title' }, 'Blocks and copy'));
  out.push(h('ul', { class: 'cc-groups' }, [...groups.values()].map(({ key, first, block }) => {
    const inGroup = findings.filter((f) => unitGroup.get(f.unitId) === key);
    const title = block ? block.label : runTitle(first);
    const selected = block && block.ordinal === selectedBlockIndex();
    return expandable(key, selected ? `${title} · selected` : title, countBySeverity(inGroup), () => h(
      'div',
      { class: 'cc-list' },
      block && !selected && inGroup.some(isApplicable) && canReplaceInPlace() && noCanvasAgent()
        ? h('p', { class: 'cc-hint' }, 'Click into this block in the editor first to fix it in place without a reload.')
        : null,
      inGroup.length ? inGroup.map(findingCard) : h('p', { class: 'cc-empty cc-clear' }, 'No findings.'),
    ));
  })));
  const skipped = state.page.blocks.filter((b) => b.skipped);
  if (skipped.length) {
    out.push(h('p', { class: 'cc-hint' }, `Not checked: ${skipped.map((b) => b.label).join(', ')}.`));
  }

  out.push(applyAllControls('page', findings));

  // The handoff: this plugin finds typos; the governance agent decides whether the page goes live.
  const prompt = state.config.governancePrompt.replace('{path}', state.ctx.path);
  out.push(h(
    'section',
    { class: 'cc-handoff' },
    h('p', {}, toFix
      ? `${toFix} thing${toFix === 1 ? '' : 's'} to fix. When they are clear, send this page for a governance check.`
      : 'Nothing to fix. Send this page for a governance check.'),
    h('button', {
      class: 'cc-btn',
      onClick: () => state.actions.setPrompt?.(prompt, { autoSend: false }),
    }, 'Send for governance check'),
  ));
  return out;
}

function renderAdminView() {
  const s = state.status;
  const out = [h('h2', {}, 'Settings')];
  if (!state.broker) {
    out.push(notice('info', 'This copy of the plugin has no broker. Load it from the App Builder deployment to turn on spelling and grammar.'));
  }
  if (state.statusError) out.push(notice('warning', state.statusError.message));
  const rows = [];
  const row = (label, ...value) => rows.push(h('dt', {}, label), h('dd', {}, ...value));
  if (s) {
    row('Key', s.configured ? `Set, ending ${s.keyLast4 ?? '••••'}${s.keySetAt ? ` (since ${formatDate(s.keySetAt)})` : ''}` : 'Not set');
    row('Provider', `${s.provider}${s.providerVersion ? ` (${s.providerVersion})` : ''}`, s.providerSupported ? null : h('span', { class: 'cc-bad' }, ' not supported by the broker'));
    row('Endpoint', s.endpointHost || '—', s.endpointAllowed ? null : h('span', { class: 'cc-bad' }, ' not allowed by the broker'));
    row('Language', s.language);
    const pct = s.budget ? Math.min(100, Math.round((s.used / s.budget) * 100)) : 100;
    row(
      'Usage this month',
      `${formatNumber(s.used)} of ${formatNumber(s.budget)} characters`,
      h('span', { class: 'cc-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(s.budget), 'aria-valuenow': String(s.used) }, h('span', { style: `width:${pct}%` })),
      h('span', { class: 'cc-hint' }, `Resets ${formatDate(s.resetDate)}. ${formatNumber(s.requests)} checks.`),
    );
    if (s.dropped !== undefined) {
      row('Findings dropped', `${formatNumber(s.dropped)} this month, ${state.dropped} this session`, h('span', { class: 'cc-hint' }, 'Suggestions that crossed formatting and could not be applied safely.'));
    }
  }
  row(
    'Canvas agent',
    state.canvas ? 'Connected: Apply selects the block for the author.'
      : 'Not found on this canvas: authors must click into a block before applying its fixes.',
    state.canvas ? null : h('span', { class: 'cc-hint' }, 'Add the Copy Check line to the site\'s scripts/scripts.js (see the README).'),
  );
  row('Apply all', h('ul', { class: 'cc-policy' }, POLICY_CLASSES.map((c) => h('li', {}, state.config.applyAll.has(c) ? '✓ ' : '✗ ', POLICY_LABEL[c]))));
  row('House style', `${state.config.terms.length} term${state.config.terms.length === 1 ? '' : 's'} from the terms sheet`);
  out.push(h('dl', { class: 'cc-settings' }, rows));

  out.push(h('h3', { class: 'cc-section-title' }, 'What is sent'));
  out.push(h('p', { class: 'cc-hint' }, `Only the text of the pieces of copy being checked${s?.endpointHost ? `, to ${s.endpointHost}` : ''}. No page path, no author identity, no block names. House style and built-in checks run in your browser and send nothing.`));

  if (state.broker && s) {
    out.push(h('h3', { class: 'cc-section-title' }, s.configured ? 'Rotate the key' : 'Set the key'));
    const input = h('input', {
      type: 'password', id: 'cc-key', autocomplete: 'off', placeholder: 'Sapling API key', 'aria-label': 'Sapling API key',
    });
    const form = h(
      'form',
      {
        class: 'cc-key-form',
        onSubmit: async (e) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          state.busy = 'key';
          render();
          try {
            const r = await state.broker.setKey(input.value.trim());
            setMessage(r.quotaSpent ? 'warning' : 'success', r.quotaSpent
              ? `Key saved, ending ${r.keyLast4}. Its quota is spent for this period.`
              : `Key validated and saved, ending ${r.keyLast4}.`);
          } catch (err) {
            setMessage('error', `${err.message} The old key is unchanged.`);
          }
          state.busy = '';
          await refreshStatus();
          render();
        },
      },
      input,
      h('button', { class: 'cc-btn cc-primary', type: 'submit', disabled: state.busy === 'key' }, state.busy === 'key' ? 'Validating…' : 'Validate and save'),
    );
    out.push(form);
    out.push(h('p', { class: 'cc-hint' }, 'The key is validated with one short check before it replaces the old one, then stored encrypted by the broker. It never reaches this browser again.'));
    if (s.configured) {
      out.push(h('button', {
        class: 'cc-btn cc-danger',
        onClick: async () => {
          // eslint-disable-next-line no-alert
          if (!window.confirm('Remove the key? Spelling and grammar stop until a new key is set.')) return;
          try {
            await state.broker.removeKey();
            setMessage('success', 'The key was removed.');
          } catch (err) {
            setMessage('error', err.message);
          }
          await refreshStatus();
          render();
        },
      }, 'Remove key'));
    }
    out.push(h('h3', { class: 'cc-section-title' }, 'Site dictionary'));
    const words = s.dictionary ?? [];
    out.push(words.length
      ? h('ul', { class: 'cc-words' }, words.map((w) => h('li', {}, w, h('button', {
        class: 'cc-link',
        'aria-label': `Remove ${w}`,
        onClick: async () => {
          try {
            await state.broker.removeWord(w);
            s.dictionary = words.filter((x) => x !== w);
          } catch (err) {
            setMessage('error', err.message);
          }
          render();
        },
      }, 'remove'))))
      : h('p', { class: 'cc-hint' }, 'No words yet. Authors add them with “Add to dictionary”.'));
  }
  out.push(h('p', {}, h('a', { href: `https://da.live/config#/${state.ctx.org}/${state.ctx.site}/`, target: '_blank', rel: 'noopener' }, 'Edit the site config')));
  return out;
}

function render() {
  if (!state.ctx) return;
  const tabs = [['block', 'Block'], ['page', 'Page']];
  if (state.isAdmin) tabs.push(['admin', 'Settings']);
  if (state.view === 'admin' && !state.isAdmin) state.view = 'block';
  let body;
  if (!state.page && state.view !== 'admin') body = [h('p', { class: 'cc-empty' }, 'Waiting for the editor…')];
  else if (state.view === 'page') body = renderPageView();
  else if (state.view === 'admin') body = renderAdminView();
  else body = renderBlockView();
  app.replaceChildren(...[
    h('nav', { class: 'cc-tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', {
      role: 'tab',
      class: 'cc-tab',
      'aria-selected': state.view === id ? 'true' : 'false',
      onClick: () => {
        state.view = id;
        state.preview = null;
        render();
      },
    }, label))),
    state.view !== 'admin' ? remoteStatusNotice() : null,
    state.message ? notice(state.message.kind, state.message.text,
      h('button', { class: 'cc-link cc-dismiss', 'aria-label': 'Dismiss', onClick: () => { setMessage(null); render(); } }, '×')) : null,
    h('div', { class: 'cc-view' }, body),
  ].filter(Boolean));
}

/* ---------- start ---------- */

async function init() {
  const sdk = await DA_SDK;
  token = sdk.token ?? '';
  // The host posts refreshed IMS tokens on the window; keep the latest for broker calls.
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && typeof e.data?.token === 'string') token = e.data.token;
  });
  const { context = {}, actions, capabilities = {} } = sdk;
  state.ctx = { org: context.org, site: context.site ?? context.repo, path: context.path || '/' };
  state.actions = actions;
  state.capabilities = capabilities;
  state.daAdmin = daAdminOrigin();
  state.ignored = loadIgnored();
  render();

  try {
    const loaded = await loadConfig({
      daFetch: actions.daFetch, daAdmin: state.daAdmin, org: state.ctx.org, site: state.ctx.site,
    });
    state.config = loaded.config;
    state.configFound = loaded.found;
    state.isAdmin = loaded.isAdmin;
  } catch {
    setMessage('warning', 'The site config could not be read. Only built-in checks will run.');
  }

  const baseUrl = brokerUrl(document, window.location);
  if (baseUrl) {
    state.broker = createBrokerClient({
      baseUrl, getToken: () => token, org: state.ctx.org, site: state.ctx.site,
    });
    await refreshStatus();
  }

  if (capabilities.liveDocument === 1 && typeof actions.subscribeLiveDocument === 'function') {
    state.mode = 'live';
    actions.subscribeLiveDocument(onLive);
    if (capabilities.sendHTMLReplace === 1) {
      const connect = async () => {
        state.canvas?.close();
        state.canvas = await connectCanvas(state.ctx);
        state.canvasChecked = true;
        if (state.view !== 'admin') render();
      };
      connect();
      watchCanvas(state.ctx, connect);
    }
  } else {
    state.mode = 'source';
    state.view = 'page';
    await loadSource();
  }
  render();
}

init();
