/**
 * Runs in a hidden iframe that agent.js opens inside the canvas. It relays between the plugin
 * (BroadcastChannel on this origin) and the agent (its parent window). Only messages for this
 * browser tab are relayed.
 */
import { CHANNEL, TAB_KEY } from './lib/canvas.js';

export function startBridge(win = window, createChannel = (name) => new BroadcastChannel(name)) {
  const parentOrigin = (win.location.ancestorOrigins && win.location.ancestorOrigins[0]) || '*';
  const currentTab = () => {
    try {
      return win.sessionStorage.getItem(TAB_KEY);
    } catch {
      return null;
    }
  };
  const channel = createChannel(CHANNEL);
  channel.onmessage = ({ data }) => {
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('copy-check:agent-')) return;
    if (data.type === 'copy-check:agent-reply' || !data.tab || data.tab !== currentTab()) return;
    win.parent.postMessage(data, parentOrigin);
  };
  win.addEventListener('message', (e) => {
    if (e.source !== win.parent || !e.data || e.data.type !== 'copy-check:agent-reply') return;
    if (parentOrigin !== '*' && e.origin !== parentOrigin) return;
    channel.postMessage({ ...e.data, tab: currentTab() });
  });
  win.parent.postMessage({ type: 'copy-check:bridge-ready' }, parentOrigin);
  return channel;
}

if (window.parent !== window) startBridge();
