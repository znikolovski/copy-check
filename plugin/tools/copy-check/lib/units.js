/**
 * Text units: the smallest pieces of text that a correction may never cross.
 *
 * Works on both the editor's live HTML and the stored DA source HTML, which share the EDS div
 * structure: main > div (section) > div.blockname (block) > div (row) > div (cell).
 * The live HTML is the editor's live-preview rendering, so it differs from the source:
 *   - section metadata becomes classes on the section div (no section-metadata block),
 *   - the page metadata block is removed (read the title and description from the source),
 *   - every block carries data-block-index, its position in the editor document.
 *
 * Block ordinals match the host's `selection.blockIndex`: every block table except metadata and
 * section-metadata, counted in document order, nested blocks included (the host walks all
 * tables). The host reports, and replaces, the outermost block that holds the cursor, so units of
 * a nested block carry the ordinal of their outermost block.
 */
import { createTextBuilder, textTarget, attrTarget } from './runs.js';

const NON_BLOCK = new Set(['metadata', 'section-metadata']);
const NEVER_CHECK_BLOCKS = new Set(['section-metadata', 'library-metadata']);
const SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'PICTURE', 'IMG', 'SVG', 'VIDEO', 'IFRAME', 'TEMPLATE', 'KBD', 'SAMP']);
const TEXT_BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'UL', 'OL', 'PRE', 'TABLE', 'DIV']);
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const META_FIELDS = { title: 'title', description: 'description' };
const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|tel:|\/)[^\s]*$/i;

/** Fields where a mistake is public or prominent. Severity is raised one step. */
export const PROMINENT_FIELDS = new Set(['h1', 'title', 'description']);

export function blockNameOf(el) {
  return (el.classList?.[0] || el.getAttribute('class')?.split(/\s+/)[0] || '').toLowerCase();
}

function titleCase(name) {
  return name.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Build plain text and the run index for an element, skipping code, media and nested lists. */
export function buildText(el, { skipNestedLists = true } = {}) {
  const builder = createTextBuilder();
  const walk = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        builder.append(textTarget(child), child.data);
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toUpperCase();
        if (tag === 'BR') builder.breakLine();
        else if (SKIP_TAGS.has(tag)) builder.breakLine();
        else if (skipNestedLists && (tag === 'UL' || tag === 'OL')) builder.breakLine();
        else walk(child);
      }
    });
  };
  walk(el);
  return builder.finish();
}

/** A block: a div with a block class, or one the editor marked with data-block-index. */
function isBlockEl(el) {
  return el.tagName.toUpperCase() === 'DIV' && (!!blockNameOf(el) || el.hasAttribute('data-block-index'));
}

function hasTextBlockChildren(el) {
  return [...el.children].some((c) => TEXT_BLOCK_TAGS.has(c.tagName.toUpperCase()));
}

/**
 * The text-bearing elements inside a container, in order. Lists yield one item per <li>;
 * blockquotes yield their paragraphs. Code and preformatted text are never returned.
 */
function textElements(container) {
  const out = [];
  const visit = (el) => {
    const tag = el.tagName.toUpperCase();
    if (tag === 'PRE' || tag === 'CODE' || tag === 'TABLE' || isBlockEl(el)) return;
    if (tag === 'UL' || tag === 'OL') {
      [...el.children].forEach((li) => visit(li));
      return;
    }
    if (tag === 'LI') {
      out.push(el);
      [...el.children].filter((c) => /^(UL|OL)$/i.test(c.tagName)).forEach(visit);
      return;
    }
    if ((tag === 'BLOCKQUOTE' || tag === 'DIV') && hasTextBlockChildren(el)) {
      [...el.children].forEach(visit);
      return;
    }
    out.push(el);
  };
  [...container.children].forEach(visit);
  return out;
}

function fieldOf(el) {
  const tag = el.tagName.toUpperCase();
  if (HEADINGS.has(tag)) return tag.toLowerCase();
  if (tag === 'LI') return 'li';
  return 'p';
}

function fieldLabel(field) {
  if (field === 'li') return 'List item';
  if (field === 'p') return 'Paragraph';
  if (/^h\d$/.test(field)) return `Heading ${field[1]}`;
  return field;
}

function isImageLink(a) {
  return !!a.querySelector('picture, img') || a.getAttribute('data-edit-as') === 'image';
}

/**
 * Extract units from a document.
 * @param {Document} doc
 * @param {{ skipBlocks?: Set<string> }} [options]
 * @returns {{ units: object[], blocks: object[], root: Element }}
 */
export function extractUnits(doc, { skipBlocks = new Set() } = {}) {
  const root = doc.querySelector('main') || doc.body;
  const units = [];
  const blocks = [];
  const tagCounters = {};
  const nameCounters = {};
  let ordinal = 0;

  // Every div directly under main is a section, whatever classes section metadata gave it.
  const sections = [...root.children].filter((c) => c.tagName.toUpperCase() === 'DIV');
  const sectionList = sections.length ? sections : [root];

  const addUnit = (unit) => {
    units.push(unit);
    return unit;
  };

  // Images and links inside a text element become their own units.
  const addSubUnits = (el, parentId, ctx) => {
    // A list item owns only what is not inside a nested list item.
    const owns = (node) => el.tagName.toUpperCase() !== 'LI' || node.closest('li') === el;
    let imageCount = 0;
    el.querySelectorAll('img').forEach((img) => {
      if (!owns(img)) return;
      const suffix = imageCount ? `:alt${imageCount}` : ':alt';
      imageCount += 1;
      const alt = img.getAttribute('alt') ?? '';
      const builder = createTextBuilder();
      builder.append(attrTarget(img, 'alt'), alt);
      const { text, runs } = builder.finish();
      addUnit({
        ...ctx,
        id: `${parentId}${suffix}`,
        kind: 'alt',
        field: 'alt',
        label: `${ctx.label} · alt text`,
        text,
        runs,
        hasAltAttr: img.hasAttribute('alt'),
        imageSrc: img.getAttribute('src') || '',
      });
    });
    let linkCount = 0;
    el.querySelectorAll('a[href]').forEach((a) => {
      if (!owns(a) || isImageLink(a)) return;
      const { text, runs } = buildText(a);
      if (!text) return;
      addUnit({
        ...ctx,
        id: `${parentId}:a:${linkCount}`,
        kind: 'link',
        field: 'link',
        label: `${ctx.label} · link text`,
        text,
        runs,
        href: a.getAttribute('href') || '',
      });
      linkCount += 1;
    });
  };

  const addTextUnit = (el, id, ctx, field) => {
    const { text, runs } = buildText(el);
    if (text && !URLISH.test(text)) {
      addUnit({
        ...ctx, id, kind: 'text', field, text, runs,
      });
    }
    addSubUnits(el, id, ctx);
  };

  const addMetaUnits = (block, sectionIndex) => {
    [...block.children].forEach((row) => {
      const [keyCell, valueCell] = row.children;
      const key = keyCell?.textContent.trim().toLowerCase();
      const field = META_FIELDS[key];
      if (!field || !valueCell) return;
      const target = valueCell.querySelector('p') || valueCell;
      const { text, runs } = buildText(target);
      addUnit({
        id: `meta:${field}`,
        kind: 'meta',
        field,
        label: field === 'title' ? 'Page title' : 'Meta description',
        text,
        runs,
        blockOrdinal: null,
        blockName: 'metadata',
        sectionIndex,
        container: block,
      });
    });
  };

  // Recurses into nested blocks so ordinals follow the host's document-order count.
  const processBlock = (blockEl, sectionIndex, top) => {
    const name = blockNameOf(blockEl) || 'block';
    if (name === 'metadata' && !top) {
      addMetaUnits(blockEl, sectionIndex);
      return;
    }
    const counted = !NON_BLOCK.has(name);
    const blockOrdinal = counted ? ordinal : null;
    if (counted) ordinal += 1;
    const nth = nameCounters[name] ?? 0;
    nameCounters[name] = nth + 1;
    const blockId = nth ? `${name}.${nth}` : name;
    const proseIndex = Number.parseInt(blockEl.getAttribute('data-block-index'), 10);
    const block = {
      ordinal: blockOrdinal,
      name,
      id: blockId,
      label: blockOrdinal === null ? titleCase(name) : `${titleCase(name)} (block ${blockOrdinal + 1})`,
      sectionIndex,
      el: blockEl,
      proseIndex: Number.isInteger(proseIndex) ? proseIndex : null,
      topOrdinal: top ? top.ordinal : blockOrdinal,
      nested: !!top,
      skipped: NEVER_CHECK_BLOCKS.has(name) || skipBlocks.has(name) || !!top?.skipped,
    };
    if (counted) blocks.push(block);
    const outer = top || block;
    [...blockEl.children].forEach((row, r) => {
      [...row.children].forEach((cell, c) => {
        const cellId = `${blockId}:${r}:${c}`;
        const ctx = {
          blockOrdinal: outer.ordinal,
          blockName: name,
          sectionIndex,
          row: r,
          col: c,
          container: outer.el,
          label: top ? `${top.label} › ${titleCase(name)} · row ${r + 1}, column ${c + 1}`
            : `${block.label} · row ${r + 1}, column ${c + 1}`,
        };
        if (!hasTextBlockChildren(cell)) {
          if (!block.skipped) addTextUnit(cell, cellId, ctx, 'cell');
          return;
        }
        let k = 0;
        [...cell.children].forEach((child) => {
          if (isBlockEl(child)) {
            processBlock(child, sectionIndex, outer);
            return;
          }
          textElements({ children: [child] }).forEach((el) => {
            if (!block.skipped) addTextUnit(el, k ? `${cellId}.${k}` : cellId, ctx, fieldOf(el));
            k += 1;
          });
        });
      });
    });
  };

  sectionList.forEach((section, sectionIndex) => {
    [...section.children].forEach((child) => {
      if (isBlockEl(child)) {
        processBlock(child, sectionIndex, null);
        return;
      }
      // Default content.
      textElements({ children: [child] }).forEach((el) => {
        const field = fieldOf(el);
        const counterKey = field === 'li' ? 'li' : field;
        const n = tagCounters[counterKey] ?? 0;
        tagCounters[counterKey] = n + 1;
        const ctx = {
          blockOrdinal: null,
          blockName: null,
          sectionIndex,
          container: el,
          label: `${fieldLabel(field)} ${n + 1}`,
        };
        addTextUnit(el, `${counterKey}:${n}`, ctx, field);
      });
    });
  });

  return { units, blocks, root };
}

/** Parse HTML (live `<main>` or full DA source) into a Document. */
export function parseHtml(html, DOMParserImpl = globalThis.DOMParser) {
  return new DOMParserImpl().parseFromString(html, 'text/html');
}
