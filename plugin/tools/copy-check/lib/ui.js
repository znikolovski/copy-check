/** Small DOM helpers and presentational pieces. No framework, no build step. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(props ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  });
  children.flat(Infinity).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return el;
}

export const SEVERITY_LABEL = { must: 'Must fix', should: 'Should fix', consider: 'Consider' };

const SOURCE_LABEL = { sapling: 'Sapling', terms: 'House style', local: 'Built-in check' };

export function sourceLabel(finding) {
  const source = SOURCE_LABEL[finding.source] ?? finding.source;
  if (finding.source === 'terms') return source;
  return finding.label && finding.label !== source ? `${source} · ${capitalise(finding.label)}` : source;
}

export function capitalise(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function formatAge(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(typeof iso === 'number' ? iso : `${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

/** The original text with the span marked, trimmed to a readable window. */
export function snippet(finding, radius = 50) {
  const text = finding.unitText;
  const { start, end } = finding;
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  const before = (from > 0 ? '…' : '') + text.slice(from, start);
  const after = text.slice(end, to) + (to < text.length ? '…' : '');
  if (!text) return h('p', { class: 'cc-snippet cc-snippet-empty' }, '(empty)');
  const marked = start === end
    ? h('mark', { class: 'cc-insert', title: 'Insertion point' }, '‸')
    : h('mark', {}, text.slice(start, end));
  return h('p', { class: 'cc-snippet' }, before, marked, after);
}

export function suggestion(finding) {
  if (typeof finding.replacement !== 'string') return null;
  if (finding.replacement === '') return h('p', { class: 'cc-suggestion' }, h('span', { class: 'cc-arrow' }, '→'), h('em', {}, 'remove'));
  return h('p', { class: 'cc-suggestion' }, h('span', { class: 'cc-arrow' }, '→'), h('strong', {}, finding.replacement));
}

export function countsLine(counts) {
  const parts = ['must', 'should', 'consider']
    .filter((s) => counts[s])
    .map((s) => h('span', { class: `cc-count cc-${s}` }, `${counts[s]} ${s}`));
  return parts.length ? h('span', { class: 'cc-counts' }, parts) : h('span', { class: 'cc-counts cc-clear' }, 'Nothing found');
}

export function notice(kind, ...content) {
  return h('div', { class: `cc-notice cc-notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, ...content);
}
