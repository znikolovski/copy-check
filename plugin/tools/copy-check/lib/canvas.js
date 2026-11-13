/**
 * Talks to the canvas agent (agent.js, loaded by the site inside the Experience Workspace canvas).
 *
 * The plugin cannot find the canvas window: both frames live in shadow DOM. Instead the agent
 * opens bridge.html from the plugin's own origin inside the canvas, and the plugin and the bridge
 * share a BroadcastChannel. Browsers partition the channel by top-level site, so only frames of
 * this origin under the same Experience Workspace page can join. Messages carry a per-tab ID kept
 * in sessionStorage, so a second tab is never driven.
 *
 * The agent does what an author's click does: it presses on a block in the canvas, and the
 * canvas's own quick-edit script asks the editor to select that block (NODE_SELECT).
 */

export const CHANNEL = 'copy-check:canvas';
export const TAB_KEY = 'copy-check:tab';
const CALL_TIMEOUT = 5000;
const HELLO_TIMEOUT = 1500;

export function tabId(storage) {
  let id = storage.getItem(TAB_KEY);
  if (!id) {
    id = crypto.randomUUID();
    storage.setItem(TAB_KEY, id);
  }
  return id;
}

function channelClient({ org, site, tab }, createChannel) {
  const channel = createChannel(CHANNEL);
  const pending = new Map();
  channel.onmessage = ({ data }) => {
    if (!data || data.type !== 'copy-check:agent-reply' || data.tab !== tab) return;
    const call = pending.get(data.id);
    if (!call) return;
    // The agent reports the site it runs on; ignore a canvas of another site.
    if (data.org !== org || data.site !== site) return;
    pending.delete(data.id);
    clearTimeout(call.timer);
    if (data.ok) call.resolve(data.result);
    else call.reject(Object.assign(new Error(data.error), { phase: data.phase }));
  };
  const call = (type, args, timeoutMs = CALL_TIMEOUT) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('The canvas did not answer.'), { phase: 'connect' }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    channel.postMessage({
      type, id, tab, org, site, args,
    });
  });
  return { call, close: () => channel.close() };
}

/** Calls `onReady` whenever an agent in this tab starts for this site (canvas loaded or reloaded). */
export function watchCanvas({ org, site }, onReady, {
  storage = window.sessionStorage,
  createChannel = (name) => new BroadcastChannel(name),
} = {}) {
  let tab;
  try {
    tab = tabId(storage);
  } catch {
    return () => {};
  }
  const channel = createChannel(CHANNEL);
  channel.onmessage = ({ data }) => {
    if (!data || data.type !== 'copy-check:agent-reply' || data.event !== 'ready') return;
    if (data.tab !== tab || data.org !== org || data.site !== site) return;
    onReady();
  };
  return () => channel.close();
}

/** Resolves with a canvas client, or null when the site has no agent in this canvas. */
export async function connectCanvas({ org, site }, {
  storage = window.sessionStorage,
  createChannel = (name) => new BroadcastChannel(name),
  helloTimeout = HELLO_TIMEOUT,
} = {}) {
  let tab;
  try {
    tab = tabId(storage);
  } catch {
    return null;
  }
  const client = channelClient({ org, site, tab }, createChannel);
  try {
    const hello = await client.call('copy-check:agent-hello', null, helloTimeout);
    return {
      path: hello.path,
      /** Select the block at this editor position, as a click on it in the canvas would. */
      selectBlock: (proseIndex, { force = false } = {}) => client.call('copy-check:agent-select-block', { proseIndex, force }),
      close: client.close,
    };
  } catch {
    client.close();
    return null;
  }
}
