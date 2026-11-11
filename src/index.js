const { fetch } = require('@forge/api');
const { XrayClient, XrayError, DEFAULT_BASE_URL } = require('./xrayClient');
const { readXray } = require('./readXray');

let client;

function getClient() {
  if (!client) {
    client = new XrayClient({
      clientId: process.env.XRAY_CLIENT_ID,
      clientSecret: process.env.XRAY_CLIENT_SECRET,
      baseUrl: process.env.XRAY_BASE_URL || DEFAULT_BASE_URL,
      fetch,
    });
  }
  return client;
}

/** Web trigger query params arrive as { name: [value] }. */
function first(params, name) {
  const v = params && params[name];
  return Array.isArray(v) ? v[0] : v;
}

function header(headers, name) {
  if (!headers) return undefined;
  const match = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return match ? first(headers, match) : undefined;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(body),
  };
}

/**
 * Web trigger handler.
 *
 * GET  <webtrigger-url>?type=tests&jql=project%20%3D%20ABC&limit=20
 * GET  <webtrigger-url>?type=testExecutions&key=ABC-42
 * POST <webtrigger-url>  {"type":"testPlans","jql":"project = ABC"}
 *
 * If WEBTRIGGER_SECRET is set, callers must send it in the `x-api-key` header.
 */
async function handler(event) {
  try {
    const secret = process.env.WEBTRIGGER_SECRET;
    if (secret && header(event.headers, 'x-api-key') !== secret) {
      return respond(401, { error: 'Unauthorized' });
    }

    let params = {};
    if (event.body) {
      try {
        params = JSON.parse(event.body);
      } catch {
        return respond(400, { error: 'Body must be valid JSON' });
      }
    } else {
      const q = event.queryParameters || {};
      params = {
        type: first(q, 'type'),
        jql: first(q, 'jql'),
        key: first(q, 'key'),
        limit: first(q, 'limit'),
        start: first(q, 'start'),
      };
    }

    const data = await readXray(getClient(), params);
    return respond(200, data);
  } catch (err) {
    console.error('read-xray failed', err.message, err.details || '');
    const status = err instanceof XrayError && err.status ? err.status : 500;
    return respond(status, { error: err.message, details: err.details });
  }
}

module.exports = { handler, readXray, getClient };
