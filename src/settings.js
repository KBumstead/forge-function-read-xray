/**
 * Resolver for the Jira admin settings page (jira:adminPage).
 *
 * Every call checks that the current user is a Jira administrator before
 * reading or changing anything.
 */
const { describeConfig, saveConfig, clearConfig, loadConfig, isAllowedBaseUrl } = require('./config');
const { XrayClient } = require('./xrayClient');

async function isJiraAdmin(api) {
  const res = await api
    .asUser()
    .requestJira(api.route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  if (!res.ok) return false;
  const body = await res.json();
  return Boolean(
    body && body.permissions && body.permissions.ADMINISTER && body.permissions.ADMINISTER.havePermission
  );
}

function errorMessage(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

/**
 * Builds the resolver functions. Dependencies are injected for tests.
 * @param {{ api: object, kvs: object, fetch: Function }} deps
 */
function createSettingsHandlers({ api, kvs, fetch }) {
  async function guard(fn) {
    try {
      if (!(await isJiraAdmin(api))) {
        return { ok: false, error: 'Only Jira administrators can manage Xray Reader settings.' };
      }
      return await fn();
    } catch (err) {
      console.error('settings resolver failed', err.message);
      return errorMessage(err);
    }
  }

  return {
    getSettings: () => guard(async () => ({ ok: true, settings: await describeConfig(kvs) })),

    saveSettings: ({ payload }) =>
      guard(async () => {
        await saveConfig(kvs, payload || {});
        return { ok: true, settings: await describeConfig(kvs) };
      }),

    clearSettings: () =>
      guard(async () => {
        await clearConfig(kvs);
        return { ok: true, settings: await describeConfig(kvs) };
      }),

    /**
     * Tries to authenticate with Xray. Uses the values typed on the page;
     * blank fields fall back to what is currently in effect.
     */
    testConnection: ({ payload }) =>
      guard(async () => {
        const p = payload || {};
        const current = await loadConfig(kvs);
        const baseUrl = p.baseUrl || current.baseUrl;
        if (!isAllowedBaseUrl(baseUrl)) throw new Error('Unknown Xray region');
        const client = new XrayClient({
          clientId: (p.clientId || '').trim() || current.clientId,
          clientSecret: (p.clientSecret || '').trim() || current.clientSecret,
          baseUrl,
          fetch,
        });
        await client.authenticate();
        return { ok: true, message: `Connected to Xray at ${baseUrl}` };
      }),
  };
}

module.exports = { createSettingsHandlers, isJiraAdmin };
