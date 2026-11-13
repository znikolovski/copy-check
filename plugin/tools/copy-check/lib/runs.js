/**
 * The run index: plain text for one unit, plus a map from every character of that
 * text back to the DOM text node (or attribute) it came from.
 *
 * runs: [{ target, nodeStart, textStart, length }]
 *   target: { kind: 'text', node } | { kind: 'attr', el, name } | null (virtual, e.g. <br>)
 *
 * Whitespace is collapsed to one space and trimmed. A collapsed run of whitespace maps to
 * its first source character, and the run records the rest of it as `tail`, so an edit that
 * ends on that space covers the whole source whitespace.
 */

const COLLAPSIBLE = /[ \t\n\r\f]/;

export function createTextBuilder() {
  let text = '';
  const runs = [];
  // The first whitespace char of a pending gap, and how far the gap runs in that same target.
  let pending = null; // { target, offset, end }

  function emit(target, offset, char) {
    const last = runs[runs.length - 1];
    if (last && target && last.target === target && !last.tail
      && last.nodeStart + last.length === offset
      && last.textStart + last.length === text.length) {
      last.length += 1;
    } else {
      runs.push({
        target, nodeStart: offset, textStart: text.length, length: 1, tail: 0,
      });
    }
    text += char;
  }

  function flushPending() {
    if (!pending) return;
    if (text.length) {
      emit(pending.target, pending.offset, ' ');
      if (pending.target) runs[runs.length - 1].tail = pending.end - pending.offset - 1;
    }
    pending = null;
  }

  return {
    append(target, data) {
      for (let i = 0; i < data.length; i += 1) {
        const char = data[i];
        if (COLLAPSIBLE.test(char)) {
          if (!pending) pending = { target, offset: i, end: i + 1 };
          else if (pending.target === target && pending.end === i) pending.end = i + 1;
        } else {
          flushPending();
          emit(target, i, char);
        }
      }
    },
    /** A hard break (<br>) separates words but cannot be edited through. */
    breakLine() {
      pending ??= { target: null, offset: 0, end: 1 };
    },
    finish() {
      // Trailing whitespace is dropped.
      pending = null;
      return { text, runs };
    },
  };
}

export function textTarget(node) {
  return { kind: 'text', node };
}

export function attrTarget(el, name) {
  return { kind: 'attr', el, name };
}

/** Binary search for the run that holds character `index`. */
export function findRun(runs, index) {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid];
    if (index < run.textStart) hi = mid - 1;
    else if (index >= run.textStart + run.length) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Map [start, end) in unit text back to one edit on one source target.
 * Returns { target, from, to } or null when the span cannot be rejoined safely.
 */
export function mapSpan(runs, textLength, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > textLength) {
    return null;
  }
  // Source offset just after text char `index` of `run`, past any collapsed whitespace it stands for.
  const after = (run, index) => {
    const offset = run.nodeStart + (index - run.textStart) + 1;
    return index === run.textStart + run.length - 1 ? offset + (run.tail || 0) : offset;
  };
  if (start === end) {
    // Insertion: attach to the character before, so it takes that character's formatting.
    if (start > 0) {
      const run = runs[findRun(runs, start - 1)];
      if (!run?.target) return null;
      const at = after(run, start - 1);
      return { target: run.target, from: at, to: at };
    }
    const run = runs[findRun(runs, 0)];
    if (!run?.target) return null;
    return { target: run.target, from: run.nodeStart, to: run.nodeStart };
  }
  const first = findRun(runs, start);
  const last = findRun(runs, end - 1);
  if (first < 0 || last < 0) return null;
  const { target } = runs[first];
  if (!target) return null;
  for (let i = first; i <= last; i += 1) {
    // Crossing into another node (another format, a link, a <br>) cannot be rejoined.
    if (runs[i].target !== target) return null;
  }
  const from = runs[first].nodeStart + (start - runs[first].textStart);
  const to = after(runs[last], end - 1);
  return { target, from, to };
}

function readTarget(target) {
  if (target.kind === 'text') return target.node.data;
  return target.el.getAttribute(target.name) ?? '';
}

function writeTarget(target, value) {
  if (target.kind === 'text') target.node.data = value;
  else target.el.setAttribute(target.name, value);
}

/** Apply one mapped edit to the DOM. */
export function applyMappedEdit(edit, replacement) {
  const data = readTarget(edit.target);
  writeTarget(edit.target, data.slice(0, edit.from) + replacement + data.slice(edit.to));
}
