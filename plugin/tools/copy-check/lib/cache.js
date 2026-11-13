/**
 * Cache findings per unit, keyed on a hash of the normalised text plus the provider, its
 * version and the language. An unchanged paragraph is never sent twice from this browser.
 * (The broker keeps a second, site-wide cache so other authors benefit too.)
 */

export const FRESH_FOR_MS = 30 * 24 * 60 * 60 * 1000;

export async function unitHash({ provider, version, language, text }) {
  const data = new TextEncoder().encode([provider, version, language, text].join('\u0000'));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

export function createCache({ storage, prefix = 'copycheck:', max = 3000, now = () => Date.now() } = {}) {
  let store = storage;
  try {
    store ??= globalThis.localStorage;
    store.getItem(`${prefix}probe`);
  } catch {
    store = null;
  }
  store ??= memoryStorage();
  const indexKey = `${prefix}index`;

  const readIndex = () => {
    try {
      return JSON.parse(store.getItem(indexKey) || '[]');
    } catch {
      return [];
    }
  };

  return {
    /** @returns {{ edits: object[], at: number, fresh: boolean } | null} */
    get(hash) {
      try {
        const raw = store.getItem(prefix + hash);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        return { ...entry, fresh: now() - entry.at < FRESH_FOR_MS };
      } catch {
        return null;
      }
    },
    /** @returns {number} the timestamp stored */
    set(hash, edits, at = now()) {
      try {
        const index = readIndex().filter((h) => h !== hash);
        index.push(hash);
        while (index.length > max) store.removeItem(prefix + index.shift());
        store.setItem(prefix + hash, JSON.stringify({ edits, at }));
        store.setItem(indexKey, JSON.stringify(index));
      } catch {
        // Quota exceeded: caching is an optimisation, never a failure.
      }
      return at;
    },
  };
}
