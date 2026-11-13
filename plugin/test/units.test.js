import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, LIVE_PAGE } from './helpers.js';
import { extractUnits } from '../tools/copy-check/lib/units.js';

const page = () => extractUnits(parse(LIVE_PAGE));

test('block ordinals match the host: metadata and section-metadata are not blocks', () => {
  const { blocks } = page();
  assert.deepEqual(blocks.map((b) => [b.name, b.ordinal]), [['cards', 0], ['hero', 1]]);
});

test('default content units carry tag-based ids', () => {
  const ids = page().units.map((u) => u.id);
  assert.ok(ids.includes('h1:0'));
  assert.ok(ids.includes('p:0'));
  assert.ok(ids.includes('li:0'));
  assert.ok(ids.includes('li:2'), 'nested list item is its own unit');
});

test('block cells split by paragraph so a sentence never crosses elements', () => {
  const { units } = page();
  const first = units.find((u) => u.id === 'cards:0:1');
  const second = units.find((u) => u.id === 'cards:0:1.1');
  assert.equal(first.text, 'First card is is great.');
  assert.equal(second.text, 'Built on aem with edge delivery services.');
  assert.equal(first.blockOrdinal, 0);
  assert.equal(first.row, 0);
  assert.equal(first.col, 1);
});

test('inline-only cell is one unit; links become link units', () => {
  const { units } = page();
  const cell = units.find((u) => u.id === 'cards:1:1');
  assert.equal(cell.text, 'Visit adobe.com today.');
  const link = units.find((u) => u.id === 'cards:1:1:a:0');
  assert.equal(link.kind, 'link');
  assert.equal(link.href, 'https://www.example.com/x');
});

test('alt text is a unit, including empty alt', () => {
  const { units } = page();
  const alt = units.find((u) => u.id === 'p:1:alt');
  assert.equal(alt.text, 'A teh cup of coffee');
  const empty = units.find((u) => u.id === 'cards:0:0:alt');
  assert.equal(empty.text, '');
  assert.equal(empty.hasAltAttr, true);
});

test('metadata title and description are units; section metadata and code are never sent', () => {
  const { units } = page();
  assert.equal(units.find((u) => u.id === 'meta:title').text, 'Copy Check demo');
  assert.equal(units.find((u) => u.id === 'meta:description').field, 'description');
  assert.ok(!units.some((u) => u.text.includes('dark')));
  assert.ok(!units.some((u) => u.text.includes('const x')));
});

test('list item text excludes its nested list', () => {
  const { units } = page();
  assert.equal(units.find((u) => u.id === 'li:1').text, 'Two items');
});

test('skip list removes blocks but keeps their ordinal', () => {
  const { units, blocks } = extractUnits(parse(LIVE_PAGE), { skipBlocks: new Set(['cards']) });
  assert.ok(!units.some((u) => u.blockName === 'cards'));
  assert.equal(blocks.find((b) => b.name === 'hero').ordinal, 1);
});

test('source HTML (no instrumentation) yields the same unit ids', () => {
  const source = LIVE_PAGE.replace(/ data-[a-z-]+="[^"]*"/g, '');
  const a = page().units.map((u) => `${u.id}|${u.text}`);
  const b = extractUnits(parse(source)).units.map((u) => `${u.id}|${u.text}`);
  assert.deepEqual(a, b);
});

/** The editor's live-preview HTML: section metadata as classes, no metadata block, positions. */
const LIVE_PREVIEW = `<body><header></header><main>
<div><div class="hero-adventure" data-block-index="1"><div><div><h1>Hero</h1></div></div></div>
  <div class="fragment" data-block-index="20"><div><div><a href="/fragments/x">/fragments/x</a></div></div></div></div>
<div class="inverse narrow" data-style="inverse"><p>Start here.</p>
  <div class="accordion-faq" data-block-index="90"><div><div>Question one</div><div><p>Answr one.</p>
    <div class="cards" data-block-index="120"><div><div>Nested card teh text</div></div></div>
  </div></div></div></div>
<div class="secondary"><div class="cards-steps" data-block-index="300"><div><div>Step one</div></div></div></div>
</main><footer></footer></body>`;

test('live preview: classed sections are sections, and every block gets the host ordinal', () => {
  const { blocks, units } = extractUnits(parse(LIVE_PREVIEW));
  assert.deepEqual(blocks.map((b) => [b.name, b.ordinal, b.proseIndex, b.nested]), [
    ['hero-adventure', 0, 1, false],
    ['fragment', 1, 20, false],
    ['accordion-faq', 2, 90, false],
    ['cards', 3, 120, true],
    ['cards-steps', 4, 300, false],
  ]);
  assert.ok(units.some((u) => u.text === 'Start here.'), 'default content in a classed section');
  assert.equal(units.find((u) => u.text === 'Step one').blockOrdinal, 4);
});

test('nested block units belong to their outermost block, which the host selects and replaces', () => {
  const { units } = extractUnits(parse(LIVE_PREVIEW));
  const nested = units.find((u) => u.text === 'Nested card teh text');
  assert.equal(nested.blockOrdinal, 2);
  assert.equal(nested.id, 'cards:0:0');
  assert.match(nested.label, /Accordion faq \(block 3\) › Cards/);
  const answer = units.find((u) => u.text === 'Answr one.');
  assert.equal(answer.blockOrdinal, 2);
  assert.ok(!units.some((u) => u.blockOrdinal === 2 && u.text.includes('Answr one. Nested')), 'nested block text is not merged into the cell');
});
