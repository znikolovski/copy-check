/**
 * Site config: pointers, not secrets. Read from the DA site config (multi-sheet JSON).
 * The broker is not configured here: it is the deployment that serves the plugin.
 *
 *   data sheet (key | value):
 *     copycheck.provider    sapling
 *     copycheck.endpoint    https://api.sapling.ai (or a self-hosted host)
 *     copycheck.budget      5000000   (characters a month)
 *     copycheck.language    en-AU
 *     copycheck.applyall    spelling, term-case
 *     copycheck.skipblocks  product-specs, embed   (blocks whose values a connected system owns)
 *     copycheck.protect     \b[A-Z]{2,}-\d{3,}\b   (a pattern for product codes; findings there are dropped)
 *     copycheck.governance  Run a governance check on {path}
 *   terms sheet: term | type | replacement | note
 */
import { DEFAULT_APPLY_ALL, POLICY_CLASSES } from './findings.js';
import { parseTerms } from './terms.js';

export const DA_ADMIN = 'https://admin.da.live';
export const DEFAULT_GOVERNANCE_PROMPT = 'Run a governance check on {path} and tell me whether it can go live.';

function list(value) {
  return String(value ?? '').split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function sheetRows(json, name) {
  if (!json) return [];
  if (json[':type'] === 'sheet' && name === 'data') return json.data ?? [];
  return json[name]?.data ?? [];
}

function safePattern(source) {
  if (!source) return null;
  try {
    return new RegExp(source, 'gu');
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/**
 * The broker that receives the author's IMS token. It is the URL that the deployment stamped
 * into the plugin page at build time, so it can never come from site config or the page URL.
 * Only a plugin running on localhost may use a `?broker=` override, and only to localhost.
 */
export function brokerUrl(doc, location) {
  const local = LOCAL_HOSTS.includes(location.hostname);
  const override = new URLSearchParams(location.search).get('broker');
  if (local && override) {
    try {
      const url = new URL(override);
      if (LOCAL_HOSTS.includes(url.hostname)) return url.href.replace(/\/+$/, '');
    } catch { /* ignore */ }
  }
  const stamped = doc.querySelector('meta[name="copy-check-broker"]')?.content?.trim() ?? '';
  if (!stamped) return '';
  try {
    const url = new URL(stamped);
    if (url.protocol === 'https:' || (local && LOCAL_HOSTS.includes(url.hostname))) return url.href.replace(/\/+$/, '');
  } catch { /* ignore */ }
  return '';
}

export function parseConfig(json) {
  const values = {};
  sheetRows(json, 'data').forEach((row) => {
    const key = String(row.key ?? row.Key ?? '').trim().toLowerCase();
    if (key.startsWith('copycheck.')) values[key.slice('copycheck.'.length)] = String(row.value ?? row.Value ?? '').trim();
  });
  const applyAll = values.applyall !== undefined ? list(values.applyall) : DEFAULT_APPLY_ALL;
  return {
    provider: values.provider || 'sapling',
    endpoint: values.endpoint || 'https://api.sapling.ai',
    budget: Number(values.budget) || null,
    language: values.language || 'en',
    applyAll: new Set(applyAll.filter((c) => POLICY_CLASSES.includes(c))),
    skipBlocks: new Set(list(values.skipblocks)),
    protect: safePattern(values.protect),
    governancePrompt: values.governance || DEFAULT_GOVERNANCE_PROMPT,
    terms: parseTerms(sheetRows(json, 'terms')),
  };
}

/**
 * Load the site config with the author's token.
 * @returns {{ config, isAdmin: boolean, found: boolean }}
 */
export async function loadConfig({ daFetch, daAdmin = DA_ADMIN, org, site }) {
  const resp = await daFetch(`${daAdmin}/config/${org}/${site}/`);
  if (!resp.ok) return { config: parseConfig(null), isAdmin: false, found: false };
  const json = await resp.json();
  return {
    config: parseConfig(json),
    isAdmin: !!resp.permissions?.includes('write'),
    found: true,
  };
}
