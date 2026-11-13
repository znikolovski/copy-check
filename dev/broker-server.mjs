/**
 * Runs the broker's web action locally, the way I/O Runtime invokes it, against the mocks in
 * dev/mock-server.mjs, with in-memory state and files. Reads COPYCHECK_ENCRYPTION_KEY from
 * broker/.env. Use `aio app dev` instead to run against real aio-lib-state and aio-lib-files.
 *
 *   http://localhost:8790/{route}   e.g. GET /status?org=acme&site=demo
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildDeps, handle } = require('../broker/lib/router.js');
const { memoryState, memoryFiles } = require('../broker/lib/storage.js');

const PORT = Number(process.env.BROKER_PORT || 8790);
const DA = process.env.DA_ADMIN_URL || 'http://localhost:3400/mock-da';
const envFile = fileURLToPath(new URL('../broker/.env', import.meta.url));
const ENCRYPTION_KEY = readFileSync(envFile, 'utf8').match(/^COPYCHECK_ENCRYPTION_KEY=(.+)$/m)?.[1];
if (!ENCRYPTION_KEY) throw new Error('Set COPYCHECK_ENCRYPTION_KEY in broker/.env (see broker/.env.example).');

const state = memoryState();
const files = memoryFiles();

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const params = {
    __ow_method: req.method.toLowerCase(),
    __ow_path: url.pathname,
    __ow_headers: req.headers,
    __ow_query: url.search.slice(1),
    __ow_body: chunks.length ? Buffer.concat(chunks).toString('base64') : undefined,
    ENCRYPTION_KEY,
    DA_ADMIN_URL: DA,
    ALLOWED_ENDPOINT_HOSTS: 'api.sapling.ai,localhost:3401',
    LOG_LEVEL: 'info',
  };
  const deps = await buildDeps(params, { state, files });
  const out = await handle(params, deps);
  res.writeHead(out.statusCode, out.headers || {});
  res.end(out.body ?? '');
}).listen(PORT, () => console.log(`Broker action on http://localhost:${PORT} (DA ${DA})`));
