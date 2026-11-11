const api = require('@forge/api');
const { kvs } = require('@forge/kvs');
const Resolver = require('@forge/resolver').default;
const { XrayClient, XrayError } = require('./xrayClient');
const { readXray } = require('./readXray');
const { rovoReadXray } = require('./rovo');
const { loadConfig } = require('./config');
const { createSettingsHandlers } = require('./settings');

let client;
let clientFingerprint;

/**
 * Returns an Xray client for the credentials currently in effect (admin
 * settings page first, then Forge variables). Rebuilt when they change, so a
 * new key saved on the settings page applies without a redeploy.
 */
async function getClient() {
  const config = await loadConfig(kvs);
  const fingerprint = `${config.clientId}|${config.clientSecret}|${config.baseUrl}`;
  if (!client || fingerprint !== clientFingerprint) {
    client = new XrayClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      baseUrl: config.baseUrl,
      fetch: api.fetch,
    });
    clientFingerprint = fingerprint;
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

    const data = await readXray(await getClient(), params);
    return respond(200, data);
  } catch (err) {
    console.error('read-xray failed', err.message, err.details || '');
    const status = err instanceof XrayError && err.status ? err.status : 500;
    return respond(status, { error: err.message, details: err.details });
  }
}

/**
 * Rovo action handler (also exposed as an MCP tool via the rovo:mcp module,
 * so it shows up in Rovo Studio under Connected apps).
 */
async function rovoHandler(payload) {
  return rovoReadXray(payload, getClient);
}

/** Resolver for the Jira admin settings page. */
const settingsResolver = new Resolver();
const settingsHandlers = createSettingsHandlers({ api, kvs, fetch: api.fetch });
for (const [name, fn] of Object.entries(settingsHandlers)) {
  settingsResolver.define(name, fn);
}
const settingsHandler = settingsResolver.getDefinitions();

module.exports = { handler, rovoHandler, settingsHandler, readXray, getClient };
