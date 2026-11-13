/**
 * A stand-in for the Experience Workspace canvas (the WYSIWYG page preview).
 * - Renders the live document the host sends it.
 * - Emulates the part of da-nx quick-edit that matters here (src/selection.js): a mousedown on a
 *   block ([data-block-index]) posts NODE_SELECT to the host, and Escape clears it.
 * - Loads the Copy Check agent the way a site's scripts.js line would.
 * Served from http://127.0.0.1:3400, a different origin from the host and the plugin.
 */
const AGENT = new URLSearchParams(window.location.search).get('agent');
let selected = null;

function select(proseIndex) {
  selected = proseIndex;
  document.querySelectorAll('[data-block-index]').forEach((b) => {
    b.classList.toggle('qe-selected', Number(b.getAttribute('data-block-index')) === proseIndex);
  });
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.data?.type !== 'mock-canvas:body') return;
  const doc = new DOMParser().parseFromString(e.data.html, 'text/html');
  document.querySelector('main').replaceWith(doc.querySelector('main'));
  if (selected !== null) select(selected);
});

document.addEventListener('mousedown', (e) => {
  const t = e.target;
  if (t.closest?.('picture') || t.closest?.('[data-prose-index]')) return;
  const block = t.closest?.('[data-block-index]');
  if (!block) return;
  const proseIndex = Number(block.getAttribute('data-block-index'));
  if (selected === proseIndex) return;
  select(proseIndex);
  window.parent.postMessage({ type: 'node-select', payload: { node: { anchorType: 'table', proseIndex } } }, '*');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || selected === null) return;
  select(null);
  window.parent.postMessage({ type: 'node-select', payload: { node: null } }, '*');
});

// The site's line: if (window.top !== window) import('<copy-check>/agent.js')
if (AGENT && window.top !== window) import(AGENT).catch((err) => console.error('agent failed', err));
