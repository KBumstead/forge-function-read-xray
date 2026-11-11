/**
 * Xray credentials and region.
 *
 * Saved values from the Jira admin settings page win. If nothing is saved
 * there, the Forge variables (XRAY_CLIENT_ID / XRAY_CLIENT_SECRET /
 * XRAY_BASE_URL) are used, so existing setups keep working.
 */
const { DEFAULT_BASE_URL } = require('./xrayClient');

const SETTINGS_KEY = 'xray-settings'; // { clientId, baseUrl }
const SECRET_KEY = 'xray-client-secret'; // stored with kvs.setSecret (encrypted)

const REGIONS = [
  { value: DEFAULT_BASE_URL, label: 'Global (xray.cloud.getxray.app)' },
  { value: 'https://us.xray.cloud.getxray.app', label: 'US (us.xray.cloud.getxray.app)' },
  { value: 'https://eu.xray.cloud.getxray.app', label: 'EU (eu.xray.cloud.getxray.app)' },
  { value: 'https://au.xray.cloud.getxray.app', label: 'Australia (au.xray.cloud.getxray.app)' },
];

function isAllowedBaseUrl(url) {
  return REGIONS.some((r) => r.value === url);
}

function envConfig(env = process.env) {
  return {
    clientId: env.XRAY_CLIENT_ID,
    clientSecret: env.XRAY_CLIENT_SECRET,
    baseUrl: env.XRAY_BASE_URL || DEFAULT_BASE_URL,
  };
}

/** Effective config used by the Xray client. */
async function loadConfig(kvs, env = process.env) {
  const [settings, secret] = await Promise.all([
    kvs.get(SETTINGS_KEY),
    kvs.getSecret(SECRET_KEY),
  ]);
  if (settings && settings.clientId && secret) {
    return {
      clientId: settings.clientId,
      clientSecret: secret,
      baseUrl: settings.baseUrl || DEFAULT_BASE_URL,
      source: 'settings',
    };
  }
  const fromEnv = envConfig(env);
  return { ...fromEnv, source: fromEnv.clientId && fromEnv.clientSecret ? 'variables' : 'none' };
}

/** Safe view for the settings page: never includes the secret. */
async function describeConfig(kvs, env = process.env) {
  const [settings, secret] = await Promise.all([
    kvs.get(SETTINGS_KEY),
    kvs.getSecret(SECRET_KEY),
  ]);
  const fromEnv = envConfig(env);
  const effective = await loadConfig(kvs, env);
  return {
    clientId: (settings && settings.clientId) || '',
    baseUrl: (settings && settings.baseUrl) || fromEnv.baseUrl,
    hasSecret: Boolean(secret),
    source: effective.source,
    variablesConfigured: Boolean(fromEnv.clientId && fromEnv.clientSecret),
    regions: REGIONS,
  };
}

/**
 * Save settings. A blank clientSecret keeps the stored one, so admins can
 * change the client id or region without re-typing the secret.
 */
async function saveConfig(kvs, { clientId, clientSecret, baseUrl }) {
  const id = (clientId || '').trim();
  const url = baseUrl || DEFAULT_BASE_URL;
  if (!id) throw new Error('Client ID is required');
  if (!isAllowedBaseUrl(url)) throw new Error('Unknown Xray region');

  const secret = (clientSecret || '').trim();
  if (secret) {
    await kvs.setSecret(SECRET_KEY, secret);
  } else if (!(await kvs.getSecret(SECRET_KEY))) {
    throw new Error('Client Secret is required');
  }
  await kvs.set(SETTINGS_KEY, { clientId: id, baseUrl: url });
}

async function clearConfig(kvs) {
  await Promise.all([kvs.delete(SETTINGS_KEY), kvs.deleteSecret(SECRET_KEY)]);
}

module.exports = {
  REGIONS,
  SETTINGS_KEY,
  SECRET_KEY,
  isAllowedBaseUrl,
  loadConfig,
  describeConfig,
  saveConfig,
  clearConfig,
};
