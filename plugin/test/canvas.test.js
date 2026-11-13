import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './helpers.js';

import { Event as DomEvent } from 'linkedom';

// Node has no MouseEvent/KeyboardEvent; use linkedom's Event so its dispatchEvent accepts them.
globalThis.MouseEvent ??= class extends DomEvent { constructor(type, init = {}) { super(type, init); this.button = init.button; } };
globalThis.KeyboardEvent ??= class extends DomEvent { constructor(type, init = {}) { super(type, init); this.key = init.key; } };

const { selectBlock, handle } = await import('../tools/copy-check/agent.js');
const { connectCanvas } = await import('../tools/copy-check/lib/canvas.js');

test('agent presses on the block at the editor position, as a click would', () => {
  const doc = parse('<main><div><div class="cards" data-block-index="120"><div><div>x</div></div></div></div></main>');
  const block = doc.querySelector('[data-block-index="120"]');
  const seen = [];
  ['mousedown', 'mouseup'].forEach((t) => block.addEventListener(t, (e) => seen.push([t, e.bubbles, e.button])));
  let escaped = false;
  doc.addEventListener('keydown', (e) => { escaped = e.key === 'Escape'; });
  assert.deepEqual(selectBlock({ proseIndex: 120 }, doc), { selected: true });
  assert.deepEqual(seen, [['mousedown', true, 0], ['mouseup', true, 0]]);
  assert.equal(escaped, false);
  selectBlock({ proseIndex: 120, force: true }, doc);
  assert.equal(escaped, true);
  assert.throws(() => selectBlock({ proseIndex: 999 }, doc), (e) => e.phase === 'find');
});

test('agent only answers its own site and protocol', async () => {
  const own = { org: 'acme', site: 'demo' };
  const base = { id: '1', tab: 't', org: 'acme', site: 'demo' };
  assert.equal(await handle({ ...base, site: 'other', type: 'copy-check:agent-hello' }, own), null);
  assert.equal(await handle({ ...base, type: 'block-source:agent-hello' }, own), null);
  const hello = await handle({ ...base, type: 'copy-check:agent-hello' }, own);
  assert.equal(hello.ok, true);
  const bad = await handle({ ...base, type: 'copy-check:agent-select-block', args: {} }, own);
  assert.equal(bad.ok, false);
  assert.equal(bad.phase, 'args');
});

/** Two in-process BroadcastChannel stand-ins on one bus. */
function bus() {
  const members = new Set();
  return (name) => {
    const ch = {
      name,
      onmessage: null,
      postMessage(data) { members.forEach((m) => { if (m !== ch && m.name === name) setTimeout(() => m.onmessage?.({ data })); }); },
      close() { members.delete(ch); },
    };
    members.add(ch);
    return ch;
  };
}

test('panel client: hello, then select-block through the channel; null without an agent', async () => {
  const storage = new Map();
  const store = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const createChannel = bus();
  const agentSide = createChannel('copy-check:canvas');
  const calls = [];
  agentSide.onmessage = async ({ data }) => {
    if (data.type === 'copy-check:agent-select-block') calls.push(data.args);
    const reply = await handle(data, { org: 'acme', site: 'demo' });
    if (reply) agentSide.postMessage(reply);
  };
  const canvas = await connectCanvas({ org: 'acme', site: 'demo' }, { storage: store, createChannel });
  assert.ok(canvas);
  globalThis.document = parse('<main><div><div class="cards" data-block-index="120"><div><div>x</div></div></div></div></main>');
  assert.deepEqual(await canvas.selectBlock(120), { selected: true });
  delete globalThis.document;
  assert.deepEqual(calls, [{ proseIndex: 120, force: false }]);
  const none = await connectCanvas({ org: 'acme', site: 'demo' }, { storage: store, createChannel: bus(), helloTimeout: 50 });
  assert.equal(none, null);
});
