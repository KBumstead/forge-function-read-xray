const test = require('node:test');
const assert = require('node:assert');
const { loadConfig, describeConfig, saveConfig, clearConfig, SECRET_KEY } = require('../src/config');
const { createSettingsHandlers } = require('../src/settings');

function memoryKvs() {
  const data = new Map();
  const secrets = new Map();
  return {
    data,
    secrets,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
    getSecret: async (k) => secrets.get(k),
    setSecret: async (k, v) => void secrets.set(k, v),
    deleteSecret: async (k) => void secrets.delete(k),
  };
}

function fakeApi(isAdmin) {
  return {
    route: (strings, ...vals) => strings.reduce((a, s, i) => a + s + (vals[i] ?? ''), ''),
    asUser: () => ({
      requestJira: async (path) => {
        assert.match(path, /mypermissions\?permissions=ADMINISTER/);
        return {
          ok: true,
          json: async () => ({ permissions: { ADMINISTER: { havePermission: isAdmin } } }),
        };
      },
    }),
  };
}

const env = { XRAY_CLIENT_ID: 'env-id', XRAY_CLIENT_SECRET: 'env-secret' };

test('falls back to Forge variables when nothing is saved', async () => {
  const kvs = memoryKvs();
  const c = await loadConfig(kvs, env);
  assert.deepStrictEqual(c, {
    clientId: 'env-id',
    clientSecret: 'env-secret',
    baseUrl: 'https://xray.cloud.getxray.app',
    source: 'variables',
  });
  assert.strictEqual((await loadConfig(kvs, {})).source, 'none');
});

test('saved settings win over variables; secret stored as a secret', async () => {
  const kvs = memoryKvs();
  await saveConfig(kvs, {
    clientId: ' page-id ',
    clientSecret: 'page-secret',
    baseUrl: 'https://eu.xray.cloud.getxray.app',
  });
  assert.strictEqual(kvs.secrets.get(SECRET_KEY), 'page-secret');
  const c = await loadConfig(kvs, env);
  assert.strictEqual(c.clientId, 'page-id');
  assert.strictEqual(c.clientSecret, 'page-secret');
  assert.strictEqual(c.baseUrl, 'https://eu.xray.cloud.getxray.app');
  assert.strictEqual(c.source, 'settings');
});

test('blank secret keeps the stored one; first save requires it', async () => {
  const kvs = memoryKvs();
  await assert.rejects(saveConfig(kvs, { clientId: 'a' }), /Client Secret is required/);
  await saveConfig(kvs, { clientId: 'a', clientSecret: 's1' });
  await saveConfig(kvs, { clientId: 'b', clientSecret: '' });
  const c = await loadConfig(kvs, {});
  assert.strictEqual(c.clientId, 'b');
  assert.strictEqual(c.clientSecret, 's1');
});

test('rejects unknown regions and missing client id', async () => {
  const kvs = memoryKvs();
  await assert.rejects(
    saveConfig(kvs, { clientId: 'a', clientSecret: 's', baseUrl: 'https://evil.example.com' }),
    /Unknown Xray region/
  );
  await assert.rejects(saveConfig(kvs, { clientSecret: 's' }), /Client ID is required/);
});

test('describeConfig never returns the secret', async () => {
  const kvs = memoryKvs();
  await saveConfig(kvs, { clientId: 'a', clientSecret: 'top-secret' });
  const d = await describeConfig(kvs, env);
  assert.strictEqual(d.hasSecret, true);
  assert.strictEqual(d.variablesConfigured, true);
  assert.ok(!JSON.stringify(d).includes('top-secret'));
});

test('clearConfig falls back to variables', async () => {
  const kvs = memoryKvs();
  await saveConfig(kvs, { clientId: 'a', clientSecret: 's' });
  await clearConfig(kvs);
  assert.strictEqual((await loadConfig(kvs, env)).source, 'variables');
});

test('resolver refuses non-admins and changes nothing', async () => {
  const kvs = memoryKvs();
  const h = createSettingsHandlers({ api: fakeApi(false), kvs, fetch: async () => {} });
  const res = await h.saveSettings({ payload: { clientId: 'x', clientSecret: 'y' } });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Only Jira administrators/);
  assert.strictEqual(kvs.secrets.size, 0);
  assert.strictEqual((await h.getSettings()).ok, false);
});

test('resolver saves for admins and tests the connection', async () => {
  const kvs = memoryKvs();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '"tok"' };
  };
  const h = createSettingsHandlers({ api: fakeApi(true), kvs, fetch });

  const saved = await h.saveSettings({ payload: { clientId: 'id1', clientSecret: 'sec1' } });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.settings.source, 'settings');

  // Blank secret on the page -> test uses the saved one.
  const t = await h.testConnection({ payload: { clientId: 'id1', clientSecret: '' } });
  assert.strictEqual(t.ok, true);
  assert.deepStrictEqual(calls[0].body, { client_id: 'id1', client_secret: 'sec1' });
  assert.match(calls[0].url, /xray\.cloud\.getxray\.app\/api\/v2\/authenticate$/);
});

test('test connection reports Xray auth failures', async () => {
  const kvs = memoryKvs();
  const fetch = async () => ({ ok: false, status: 401, text: async () => 'bad' });
  const h = createSettingsHandlers({ api: fakeApi(true), kvs, fetch });
  const t = await h.testConnection({ payload: { clientId: 'a', clientSecret: 'b' } });
  assert.deepStrictEqual(t, { ok: false, error: 'Xray authentication failed (401)' });
});
