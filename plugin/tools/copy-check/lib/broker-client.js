/**
 * Client for the Copy Check broker. The browser never holds the provider key.
 * Only unit text is sent, under opaque content-hash ids: no page path, no block names,
 * no author identity beyond the IMS token the broker needs to validate the caller.
 */

export class BrokerError extends Error {
  constructor(status, body = {}) {
    super(body.message || `Broker error ${status}`);
    this.status = status;
    this.code = body.error || (status ? `http-${status}` : 'unavailable');
    this.resetDate = body.resetDate;
  }
}

export function createBrokerClient({
  baseUrl, getToken, org, site, fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  const call = async (method, path, body) => {
    const url = new URL(`${baseUrl}${path}`);
    if (method === 'GET' || method === 'DELETE') {
      url.searchParams.set('org', org);
      url.searchParams.set('site', site);
      Object.entries(body ?? {}).forEach(([k, v]) => url.searchParams.set(k, v));
    }
    let resp;
    try {
      resp = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${getToken()}`,
          ...(method === 'GET' || method === 'DELETE' ? {} : { 'Content-Type': 'application/json' }),
        },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ org, site, ...body }),
      });
    } catch {
      throw new BrokerError(0, { error: 'unavailable', message: 'The copy check service cannot be reached.' });
    }
    let json = {};
    try {
      json = await resp.json();
    } catch {
      // Non-JSON error page.
    }
    if (!resp.ok) throw new BrokerError(resp.status, json);
    return json;
  };

  return {
    status: () => call('GET', '/status'),
    check: (units, telemetry) => call('POST', '/check', { units, telemetry }),
    setKey: (key) => call('POST', '/key', { key }),
    removeKey: () => call('DELETE', '/key'),
    addWord: (word) => call('POST', '/dictionary', { word }),
    removeWord: (word) => call('DELETE', '/dictionary', { word }),
  };
}
