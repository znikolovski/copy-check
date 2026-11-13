/**
 * A stand-in for the Experience Workspace canvas host, speaking the same MessagePort protocol
 * as da-live's ew-panel-extensions/iframe-protocol.js:
 *   ready handshake with capabilities, liveDocument / liveSelection broadcasts,
 *   acknowledged sendHTML replace with the { html, blockIndex } guard, saveDocument, setPrompt.
 * It also simulates collab: typing autosaves to the mock DA source, and a source written by
 * someone else (Route B) reloads the editor.
 *
 * It also embeds a mock canvas (dev/canvas.html) that loads the Copy Check agent, as a site's
 * scripts.js line would, and emulates quick-edit's NODE_SELECT.
 *
 * Open it at http://127.0.0.1:3400/dev/host.html. The plugin runs on localhost and the canvas on
 * [::1], so the three are different sites, as da.live, the plugin and the canvas are in EW. That
 * matters: BroadcastChannel and sessionStorage are partitioned by top-level site and by whether a
 * frame has a cross-site ancestor, and the plugin and the agent's bridge must share a partition.
 *
 * Query: ?as=author (non-admin token), ?legacy=1 (host without liveDocument / sendHTMLReplace),
 * ?agent=0 (a site without the canvas agent).
 */
const params = new URLSearchParams(window.location.search);
const TOKEN = params.get('as') === 'author' ? 'dev-author' : 'dev-admin';
const CAPABILITIES = params.get('legacy') ? {} : {
  liveDocument: 1, sendHTMLReplace: 1, chatTurnCompleted: 1, dragDrop: 1,
};
const CONTEXT = {
  org: 'acme', repo: 'demo', site: 'demo', ref: 'local', path: '/drafts/copy-check-demo', view: 'edit', branch: 'main',
};
const DA = `${window.location.origin}/mock-da`;
const SOURCE = `${DA}/source/acme/demo${CONTEXT.path}.html`;
const NON_BLOCK = new Set(['metadata', 'section-metadata']);

const editor = document.getElementById('editor');
const iframe = document.getElementById('plugin');
const canvas = document.getElementById('canvas');
const HOST_PORT = window.location.port;
const PLUGIN_ORIGIN = `http://localhost:${HOST_PORT}`;
const CANVAS_ORIGIN = `http://[::1]:${HOST_PORT}`;
const logEl = document.getElementById('log');
let port;
let subscribed = false;
let lastBlockIndex = null;
let etag = null;
let htmlTimer;
let saveTimer;

function log(...args) {
  logEl.textContent += `${new Date().toLocaleTimeString()}  ${args.join(' ')}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

const auth = { Authorization: `Bearer ${TOKEN}` };

function blocks() {
  return [...editor.querySelectorAll(':scope > div > div[class]')]
    .filter((b) => !NON_BLOCK.has(b.classList[0]));
}

function activeBlockIndex() {
  const sel = document.getSelection();
  const node = sel?.anchorNode;
  if (!node || !editor.contains(node)) return lastBlockIndex;
  const el = node.nodeType === 1 ? node : node.parentElement;
  const block = el.closest('#editor > div > div[class]');
  const index = block ? blocks().indexOf(block) : -1;
  return index < 0 ? null : index;
}

/** Like getInstrumentedHTMLForSDK: the whole document, blocks marked with data-block-index. */
function liveHtml() {
  const clone = editor.cloneNode(true);
  clone.removeAttribute('contenteditable');
  clone.removeAttribute('spellcheck');
  clone.removeAttribute('id');
  clone.querySelectorAll('.cc-selected').forEach((b) => {
    b.classList.remove('cc-selected');
  });
  const all = [...clone.querySelectorAll(':scope > div > div[class]')].filter((b) => !NON_BLOCK.has(b.classList[0]));
  all.forEach((b, i) => b.setAttribute('data-block-index', String(100 + i * 50)));
  return `<body><header></header>${clone.outerHTML}<footer></footer></body>`;
}

function snapshot() {
  return { html: liveHtml(), selection: { blockIndex: activeBlockIndex() }, editable: true };
}

function highlight() {
  const index = activeBlockIndex();
  blocks().forEach((b, i) => b.classList.toggle('cc-selected', i === index));
  document.getElementById('sel').textContent = index === null ? 'none' : String(index);
}

function syncCanvas() {
  canvas.contentWindow?.postMessage({ type: 'mock-canvas:body', html: liveHtml() }, CANVAS_ORIGIN);
}

/** Quick-edit's NODE_SELECT from the canvas: select that block in the editor. */
function onCanvasMessage(e) {
  if (e.source !== canvas.contentWindow || e.data?.type !== 'node-select') return;
  const node = e.data.payload?.node;
  if (!node || node.anchorType !== 'table') return;
  const target = blocks().find((b, i) => 100 + i * 50 === node.proseIndex);
  if (!target) return;
  const range = document.createRange();
  range.selectNodeContents(target.querySelector('div > div') || target);
  range.collapse(true);
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
  target.scrollIntoView({ block: 'nearest' });
  log(`canvas NODE_SELECT -> editor selected block ${blocks().indexOf(target)}`);
  broadcastSelection();
}
window.addEventListener('message', onCanvasMessage);

function broadcastDocument() {
  clearTimeout(htmlTimer);
  htmlTimer = undefined;
  syncCanvas();
  if (!subscribed) return;
  const s = snapshot();
  lastBlockIndex = s.selection.blockIndex;
  port.postMessage({ action: 'liveDocument', ...s });
}

function broadcastSelection() {
  highlight();
  const index = activeBlockIndex();
  if (!subscribed || htmlTimer !== undefined || index === lastBlockIndex) return;
  lastBlockIndex = index;
  port.postMessage({ action: 'liveSelection', selection: { blockIndex: index } });
}

async function loadFromSource(reason) {
  const resp = await fetch(SOURCE, { headers: auth });
  etag = resp.headers.get('etag');
  const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
  editor.innerHTML = doc.querySelector('main').innerHTML;
  highlight();
  log(`editor loaded from source ${etag} (${reason})`);
  broadcastDocument();
}

async function save() {
  clearTimeout(saveTimer);
  const form = new FormData();
  const html = `<body><header></header><main>${editor.innerHTML.replace(/ class="([^"]*?)\s*cc-selected"/g, ' class="$1"')}</main><footer></footer></body>`;
  form.set('data', new Blob([html], { type: 'text/html' }));
  const resp = await fetch(SOURCE, { method: 'POST', headers: { ...auth, 'x-da-initiator': 'collab' }, body: form });
  etag = resp.headers.get('etag');
  return resp.ok;
}

function reply(requestId, result) {
  port.postMessage({ action: 'sdkResponse', requestId, result });
}

function replaceSelectedBlock(details) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  if (details.expected !== undefined) {
    if (activeBlockIndex() !== details.expected.blockIndex) fail('WRONG_SELECTION', 'The selected block changed');
    if (liveHtml() !== details.expected.html) fail('STALE_LIVE', 'The live document changed while editing');
  }
  const index = activeBlockIndex();
  if (index === null) fail('NO_TARGET', 'Place the cursor inside content to replace.');
  const parsed = new DOMParser().parseFromString(details.html, 'text/html').body;
  if (parsed.children.length !== 1) fail('INVALID_HTML', 'Replacement must contain exactly one content node.');
  const replacement = document.importNode(parsed.firstElementChild, true);
  const target = blocks()[index];
  target.replaceWith(replacement);
  // Keep the cursor inside the replaced block, as the real host preserves the selection.
  const range = document.createRange();
  range.selectNodeContents(replacement.querySelector('p, div > div') || replacement);
  range.collapse(true);
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
}

function onPortMessage(e) {
  const { action, details, requestId } = e.data || {};
  if (action === 'subscribeLiveDocument') {
    subscribed = true;
    log('plugin subscribed to the live document');
    broadcastDocument();
    return;
  }
  if (action === 'unsubscribeLiveDocument') {
    subscribed = false;
    return;
  }
  if (action === 'sendHTML' && requestId) {
    try {
      if (!CAPABILITIES.sendHTMLReplace) throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
      replaceSelectedBlock(details);
    } catch (err) {
      log(`sendHTML replace rejected: ${err.code}`);
      reply(requestId, { ok: false, error: err.code || 'REPLACE_FAILED', message: err.message });
      return;
    }
    const s = snapshot();
    log(`sendHTML replace applied to block ${s.selection.blockIndex} (guarded: ${details.expected ? 'yes' : 'no'})`);
    broadcastDocument();
    reply(requestId, { ok: true, ...s });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1500);
    return;
  }
  if (action === 'saveDocument' && requestId) {
    save().then((ok) => {
      log(`saveDocument -> ${ok ? 'saved' : 'failed'} ${etag}`);
      reply(requestId, ok ? { ok: true } : { ok: false, error: 'save-failed' });
    });
    return;
  }
  if (action === 'setPrompt') {
    log(`setPrompt -> chat: "${details.text}" (autoSend: ${details.autoSend})`);
    return;
  }
  if (action) log(`plugin action: ${action}`);
}

function connect() {
  const channel = new MessageChannel();
  port = channel.port1;
  port.onmessage = onPortMessage;
  setTimeout(() => {
    iframe.contentWindow.postMessage({
      ready: true, project: CONTEXT, context: CONTEXT, token: TOKEN, capabilities: CAPABILITIES,
    }, '*', [channel.port2]);
    log(`ready handshake sent (token ${TOKEN})`);
  }, 750);
}

editor.addEventListener('input', () => {
  if (subscribed) {
    clearTimeout(htmlTimer);
    htmlTimer = setTimeout(broadcastDocument, 150);
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1500);
});
document.addEventListener('selectionchange', broadcastSelection);

// Collab: someone else's source write (Route B) reloads the editor.
setInterval(async () => {
  const resp = await fetch(SOURCE, { method: 'GET', headers: auth });
  const remote = resp.headers.get('etag');
  if (etag && remote && remote !== etag) await loadFromSource('source changed outside the editor (syncadmin)');
}, 1000);

document.getElementById('reset').addEventListener('click', async () => {
  await fetch(`${DA}/_reset`, { headers: auth });
  await loadFromSource('reset');
});

document.getElementById('caps').textContent = Object.keys(CAPABILITIES).join(',') || 'none';
document.getElementById('tok').textContent = TOKEN;
await loadFromSource('initial');
iframe.addEventListener('load', connect, { once: true });
if (window.location.hostname !== '127.0.0.1') log('Open this page at http://127.0.0.1:3400/dev/host.html so the frames are cross-site, as in EW.');
const agentUrl = params.get('agent') === '0' ? '' : `${PLUGIN_ORIGIN}/tools/copy-check/agent.js`;
canvas.addEventListener('load', syncCanvas, { once: true });
canvas.src = `${CANVAS_ORIGIN}/dev/canvas.html?agent=${encodeURIComponent(agentUrl)}`;
// The deployed plugin gets its broker URL stamped in at build time; locally it is passed in.
const BROKER = params.get('broker') || 'http://localhost:8790';
iframe.src = `${PLUGIN_ORIGIN}/tools/copy-check/copy-check.html?da-admin=${encodeURIComponent(DA)}&broker=${encodeURIComponent(BROKER)}`;
