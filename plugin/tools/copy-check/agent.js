/**
 * Copy Check canvas agent. Runs inside the page preview (the canvas) and selects a block in the
 * editor the way an author's click does, so a fix can be applied straight into that block.
 * It changes nothing on the page and sends nothing anywhere but the Copy Check panel in the same
 * browser tab.
 *
 * The site loads this script in the canvas (see README). The plugin cannot reach the canvas
 * window directly, so the agent opens bridge.html from the origin it was loaded from, and the
 * plugin talks to the bridge over a BroadcastChannel (see lib/canvas.js). When the agent is
 * served from the canvas origin itself, it joins the channel directly.
 *
 * How the selection happens: Experience Workspace's quick-edit script in the canvas turns a
 * mousedown on a block element ([data-block-index]) into NODE_SELECT, and the editor selects
 * that block. The agent dispatches that mousedown.
 */
import { CHANNEL, TAB_KEY } from './lib/canvas.js';

const HOST = /^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\.(aem\.page|aem\.live|preview\.da\.live|stage-preview\.da\.live)$/;
const OWN_URL = new URL(import.meta.url);

/** The site this canvas shows, from its hostname. Null on a local dev server. */
export function canvasSite(hostname = window.location.hostname) {
  const m = HOST.exec(hostname);
  return m ? { site: m[2], org: m[3] } : null;
}

function press(el, type) {
  el.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true, button: 0, buttons: type === 'mousedown' ? 1 : 0, view: el.ownerDocument?.defaultView ?? null,
  }));
}

/**
 * Selects the block whose editor position is `proseIndex`. With `force`, first clears the
 * canvas's own idea of the selected block (Escape), for when it is out of step with the editor.
 */
export function selectBlock({ proseIndex, force = false } = {}, doc = globalThis.document) {
  if (!Number.isInteger(proseIndex)) throw Object.assign(new Error('No block position.'), { phase: 'args' });
  const el = doc.querySelector(`[data-block-index="${proseIndex}"]`);
  if (!el) throw Object.assign(new Error('The block is not on the canvas.'), { phase: 'find' });
  if (force) {
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  press(el, 'mousedown');
  press(el, 'mouseup');
  return { selected: true };
}

/** Handles one plugin command. Returns the reply, or null when the command is not for this canvas. */
export async function handle(msg, own = canvasSite()) {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('copy-check:agent-') || msg.type === 'copy-check:agent-reply') return null;
  if (own && (msg.org !== own.org || msg.site !== own.site)) return null;
  const base = {
    type: 'copy-check:agent-reply', id: msg.id, tab: msg.tab, org: msg.org, site: msg.site,
  };
  if (msg.type === 'copy-check:agent-hello') return { ...base, ok: true, result: { hello: true, path: globalThis.location?.pathname ?? '' } };
  const methods = {
    'copy-check:agent-select-block': () => selectBlock(msg.args || {}),
  };
  const fn = methods[msg.type];
  if (!fn) return null;
  try {
    return { ...base, ok: true, result: await fn() };
  } catch (err) {
    return {
      ...base, ok: false, error: err.message, phase: err.phase || null,
    };
  }
}

/** Tells a panel that is already open that the agent has started. */
export function readyAnnouncement(own = canvasSite()) {
  return {
    type: 'copy-check:agent-reply', id: 'ready', event: 'ready', ok: true, org: own?.org, site: own?.site,
  };
}

function currentTab() {
  try {
    return window.sessionStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

function joinChannel() {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = async ({ data }) => {
    if (!data || !data.tab || data.tab !== currentTab()) return;
    const reply = await handle(data);
    if (reply) channel.postMessage(reply);
  };
  const tab = currentTab();
  if (tab && canvasSite()) channel.postMessage({ ...readyAnnouncement(), tab });
}

function openBridge() {
  const frame = document.createElement('iframe');
  frame.src = new URL('./bridge.html', OWN_URL).href;
  frame.title = 'Copy Check';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  window.addEventListener('message', async (e) => {
    if (e.source !== frame.contentWindow || e.origin !== OWN_URL.origin) return;
    if (e.data && e.data.type === 'copy-check:bridge-ready') {
      frame.contentWindow.postMessage(readyAnnouncement(), OWN_URL.origin);
      return;
    }
    const reply = await handle(e.data);
    if (reply) frame.contentWindow.postMessage(reply, OWN_URL.origin);
  });
  (document.body || document.documentElement).append(frame);
}

if (typeof window !== 'undefined' && window.top !== window && !window.copyCheckAgentStarted) {
  window.copyCheckAgentStarted = true;
  if (OWN_URL.origin === window.location.origin) joinChannel();
  else openBridge();
}
