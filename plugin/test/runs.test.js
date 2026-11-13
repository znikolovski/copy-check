import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './helpers.js';
import {
  createTextBuilder, textTarget, mapSpan, applyMappedEdit, findRun,
} from '../tools/copy-check/lib/runs.js';
import { buildText } from '../tools/copy-check/lib/units.js';

test('collapses whitespace and trims', () => {
  const doc = parse('<p>  Hello \n\n  world  </p>');
  const { text } = buildText(doc.querySelector('p'));
  assert.equal(text, 'Hello world');
});

test('maps a span inside one node, across collapsed whitespace', () => {
  const doc = parse('<p>We   recieve it</p>');
  const p = doc.querySelector('p');
  const { text, runs } = buildText(p);
  assert.equal(text, 'We recieve it');
  const start = text.indexOf('recieve');
  const edit = mapSpan(runs, text.length, start, start + 7);
  applyMappedEdit(edit, 'receive');
  assert.equal(p.textContent, 'We   receive it');

  // A span that covers the collapsed gap is rejoined in the one node.
  const doc2 = parse('<p>We   recieve it</p>');
  const p2 = doc2.querySelector('p');
  const built = buildText(p2);
  const edit2 = mapSpan(built.runs, built.text.length, 0, 10);
  applyMappedEdit(edit2, 'We receive');
  assert.equal(p2.textContent, 'We receive it');
});

test('drops a span that crosses formatting', () => {
  const doc = parse('<p>from <strong>every</strong> one</p>');
  const { text, runs } = buildText(doc.querySelector('p'));
  assert.equal(text, 'from every one');
  assert.equal(mapSpan(runs, text.length, 0, 10), null);
  const inside = mapSpan(runs, text.length, 5, 10);
  assert.equal(inside.target.node.data, 'every');
});

test('maps insertions to the preceding character', () => {
  const doc = parse('<p>Hi <em>there</em></p>');
  const p = doc.querySelector('p');
  const { text, runs } = buildText(p);
  const edit = mapSpan(runs, text.length, 2, 2);
  applyMappedEdit(edit, ',');
  assert.equal(p.innerHTML, 'Hi, <em>there</em>');
});

test('cannot edit through a <br>', () => {
  const doc = parse('<p>one<br>two</p>');
  const { text, runs } = buildText(doc.querySelector('p'));
  assert.equal(text, 'one two');
  assert.equal(mapSpan(runs, text.length, 2, 5), null);
  assert.ok(mapSpan(runs, text.length, 4, 7));
});

test('rejects out-of-range spans', () => {
  const b = createTextBuilder();
  b.append(textTarget({ data: 'abc' }), 'abc');
  const { text, runs } = b.finish();
  assert.equal(mapSpan(runs, text.length, -1, 2), null);
  assert.equal(mapSpan(runs, text.length, 2, 9), null);
  assert.equal(mapSpan(runs, text.length, 2, 1), null);
  assert.equal(findRun(runs, 2), 0);
  assert.equal(findRun(runs, 3), -1);
});

test('skips code inside a paragraph', () => {
  const doc = parse('<p>Run <code>npm teh</code> now</p>');
  const { text } = buildText(doc.querySelector('p'));
  assert.equal(text, 'Run now');
});

test('an edit ending on a collapsed space covers all of the source whitespace', () => {
  const doc = parse('<p>foo   bar</p>');
  const p = doc.querySelector('p');
  const { text, runs } = buildText(p);
  applyMappedEdit(mapSpan(runs, text.length, 3, 4), '');
  assert.equal(p.textContent, 'foobar');

  const doc2 = parse('<p>Hello   world</p>');
  const p2 = doc2.querySelector('p');
  const built = buildText(p2);
  applyMappedEdit(mapSpan(built.runs, built.text.length, 6, 6), 'big ');
  assert.equal(p2.textContent, 'Hello   big world');

  const doc3 = parse('<p>a  b c</p>');
  const p3 = doc3.querySelector('p');
  const b3 = buildText(p3);
  applyMappedEdit(mapSpan(b3.runs, b3.text.length, 4, 5), 'C');
  applyMappedEdit(mapSpan(b3.runs, b3.text.length, 2, 3), 'B');
  assert.equal(p3.textContent, 'a  B C');
});
