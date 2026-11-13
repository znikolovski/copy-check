'use strict';

const { sha256 } = require('./crypto');

/**
 * Two stores:
 * - `state` (aio-lib-state): keys with TTL, used for access checks, rate limits, the monthly
 *   character meter and the findings cache.
 * - `files` (aio-lib-files): durable private JSON documents, used for the encrypted provider
 *   key and the site dictionary.
 * Both have in-memory implementations for tests and local runs.
 */

const MAX_STATE_TTL = 365 * 24 * 3600;

function stateKey(raw) {
  const safe = String(raw).replace(/[^a-zA-Z0-9-_.]/g, '_');
  if (safe.length <= 200) return safe;
  return `${safe.slice(0, 80)}.${sha256(raw).slice(0, 40)}`;
}

function wrapState(lib) {
  return {
    async get(key) {
      const res = await lib.get(stateKey(key));
      if (!res || res.value === undefined || res.value === null) return null;
      try {
        return JSON.parse(res.value);
      } catch {
        return null;
      }
    },
    async put(key, value, ttl = 300) {
      await lib.put(stateKey(key), JSON.stringify(value), {
        ttl: Math.max(1, Math.min(MAX_STATE_TTL, Math.round(ttl))),
      });
    },
    async delete(key) {
      await lib.delete(stateKey(key));
    },
  };
}

function wrapFiles(lib) {
  return {
    async readJson(path) {
      try {
        const buf = await lib.read(path);
        return JSON.parse(buf.toString('utf8'));
      } catch (e) {
        if (e && (e.code === 'ERROR_FILE_NOT_EXISTS' || /not exist|404/i.test(e.message))) return null;
        throw e;
      }
    },
    async writeJson(path, value) {
      await lib.write(path, JSON.stringify(value));
    },
    async readBuffer(path) {
      try {
        return await lib.read(path);
      } catch (e) {
        if (e && (e.code === 'ERROR_FILE_NOT_EXISTS' || /not exist|404/i.test(e.message))) return null;
        throw e;
      }
    },
    async writeBuffer(path, buffer) {
      await lib.write(path, buffer);
    },
    async delete(path) {
      try {
        await lib.delete(path);
      } catch {
        // already gone
      }
    },
    async list(prefix) {
      const entries = await lib.list(prefix);
      return entries.map((e) => e.name);
    },
  };
}

function memoryState(now = () => Date.now()) {
  const map = new Map();
  return {
    map,
    async get(key) {
      const entry = map.get(stateKey(key));
      if (!entry) return null;
      if (entry.exp <= now()) {
        map.delete(stateKey(key));
        return null;
      }
      return JSON.parse(entry.value);
    },
    async put(key, value, ttl = 300) {
      map.set(stateKey(key), { value: JSON.stringify(value), exp: now() + ttl * 1000 });
    },
    async delete(key) {
      map.delete(stateKey(key));
    },
  };
}

function memoryFiles() {
  const map = new Map();
  return {
    map,
    async readJson(path) {
      return map.has(path) ? JSON.parse(map.get(path)) : null;
    },
    async writeJson(path, value) {
      map.set(path, JSON.stringify(value));
    },
    async readBuffer(path) {
      return map.has(path) ? Buffer.from(map.get(path)) : null;
    },
    async writeBuffer(path, buffer) {
      map.set(path, Buffer.from(buffer));
    },
    async delete(path) {
      map.delete(path);
    },
    async list(prefix) {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

async function initStores() {
  // Loaded lazily so tests and tooling do not need the Adobe SDKs.
  // eslint-disable-next-line global-require
  const stateLib = require('@adobe/aio-lib-state');
  // eslint-disable-next-line global-require
  const filesLib = require('@adobe/aio-lib-files');
  const [state, files] = await Promise.all([stateLib.init(), filesLib.init()]);
  return { state: wrapState(state), files: wrapFiles(files) };
}

module.exports = {
  initStores, memoryState, memoryFiles, wrapState, wrapFiles, stateKey,
};
