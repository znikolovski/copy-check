'use strict';

const SECRET_PATTERNS = [
  /(Bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /"key"\s*:\s*"[^"]{8,}"/g,
];

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Removes secrets from any value before it is logged or returned.
 * Known secrets (the decrypted provider key of this invocation) are replaced verbatim,
 * and anything that looks like a bearer header or a key field is masked.
 */
function redact(value, secrets = []) {
  let text;
  if (typeof value === 'string') text = value;
  else if (value instanceof Error) text = `${value.name}: ${value.message}`;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) return text;
  [...secrets].forEach((secret) => {
    if (secret && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  });
  SECRET_PATTERNS.forEach((re) => {
    text = text.replace(re, '[REDACTED]');
  });
  return text;
}

function createLogger(sink = console, secrets = new Set(), level = 'info') {
  const levels = ['debug', 'info', 'warn', 'error'];
  const min = Math.max(0, levels.indexOf(level));
  const out = {};
  levels.forEach((name, idx) => {
    out[name] = (...args) => {
      if (idx < min) return;
      const line = args.map((a) => redact(a, secrets)).join(' ');
      (sink[name] || sink.log).call(sink, line);
    };
  });
  return out;
}

const ALLOWED_DEV_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Only the plugin origins of the site in the request may call the broker:
 * this app's own static hosting ({namespace}.adobeio-static.net), which serves the plugin for
 * every site, {ref}--{site}--{org}.aem.page|live and the DA preview proxy (a site that hosts its
 * own copy), da.live, and the local dev server.
 */
function isAllowedOrigin(origin, { org, site } = {}) {
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === 'http:' && ALLOWED_DEV_HOSTS.has(url.hostname)) return true;
  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'da.live') return true;
  const namespace = process.env.__OW_NAMESPACE;
  if (namespace && url.hostname === `${namespace.toLowerCase()}.adobeio-static.net`) return true;
  const match = url.hostname.match(/^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\.(aem\.page|aem\.live|preview\.da\.live|stage-preview\.da\.live)$/);
  if (!match) return false;
  if (!org || !site) return true;
  return match[2] === site.toLowerCase() && match[3] === org.toLowerCase();
}

function corsHeaders(origin, ctx) {
  if (!isAllowedOrigin(origin, ctx)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function respond(status, body, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

const MAX_BODY_BYTES = 256 * 1024;

function parseBody(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  if (raw.length > MAX_BODY_BYTES * 2) {
    throw new HttpError(413, 'too-large', 'The request is too large. Check fewer units at a time.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    // raw web actions deliver non-text content types base64 encoded
  }
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad-body', 'The request body is not valid JSON.');
  }
}

function parseRequest(params) {
  const method = String(params.__ow_method || 'get').toUpperCase();
  const path = `/${String(params.__ow_path || '').replace(/^\/+|\/+$/g, '')}`;
  const headers = {};
  Object.entries(params.__ow_headers || {}).forEach(([k, v]) => {
    headers[k.toLowerCase()] = v;
  });
  const query = Object.fromEntries(new URLSearchParams(params.__ow_query || ''));
  const body = method === 'GET' || method === 'DELETE' ? {} : parseBody(params.__ow_body);
  return {
    method, path, headers, query, body,
  };
}

function bearer(headers) {
  const value = headers.authorization || '';
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

module.exports = {
  HttpError,
  redact,
  createLogger,
  isAllowedOrigin,
  corsHeaders,
  respond,
  parseRequest,
  parseBody,
  bearer,
};
