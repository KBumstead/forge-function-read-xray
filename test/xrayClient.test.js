const test = require('node:test');
const assert = require('node:assert');
const { XrayClient, XrayError, clampLimit } = require('../src/xrayClient');
const { readXray } = require('../src/readXray');

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const creds = { clientId: 'id', clientSecret: 'secret' };

test('authenticates once and reuses the token', async () => {
  const fetch = mockFetch([
    { status: 200, body: '"tok123"' },
    { status: 200, body: { data: { getTests: { total: 0, results: [] } } } },
    { status: 200, body: { data: { getTests: { total: 0, results: [] } } } },
  ]);
  // (no tests returned -> no second query for runs)
  const client = new XrayClient({ ...creds, fetch });

  await client.getTests({ jql: 'project = ABC' });
  await client.getTests({ jql: 'project = ABC' });

  assert.strictEqual(fetch.calls.length, 3);
  assert.match(fetch.calls[0].url, /\/api\/v2\/authenticate$/);
  assert.deepStrictEqual(JSON.parse(fetch.calls[0].init.body), {
    client_id: 'id',
    client_secret: 'secret',
  });
  assert.strictEqual(fetch.calls[1].init.headers.Authorization, 'Bearer tok123');
  const body = JSON.parse(fetch.calls[1].init.body);
  assert.strictEqual(body.variables.jql, 'project = ABC');
  assert.strictEqual(body.variables.limit, 50);
});

test('uses a regional base url', async () => {
  const fetch = mockFetch([
    { status: 200, body: '"t"' },
    { status: 200, body: { data: { getTestPlans: { total: 0, results: [] } } } },
  ]);
  const client = new XrayClient({ ...creds, baseUrl: 'https://eu.xray.cloud.getxray.app/', fetch });
  await client.getTestPlans({ jql: 'project = ABC' });
  assert.strictEqual(fetch.calls[1].url, 'https://eu.xray.cloud.getxray.app/api/v2/graphql');
});

test('throws on failed authentication', async () => {
  const fetch = mockFetch([{ status: 401, body: 'bad creds' }]);
  const client = new XrayClient({ ...creds, fetch });
  await assert.rejects(client.getTests({ jql: 'x' }), (e) => e instanceof XrayError && e.status === 401);
});

test('surfaces GraphQL errors', async () => {
  const fetch = mockFetch([
    { status: 200, body: '"t"' },
    { status: 200, body: { errors: [{ message: 'bad jql' }] } },
  ]);
  const client = new XrayClient({ ...creds, fetch });
  await assert.rejects(client.getTests({ jql: 'x' }), /GraphQL returned errors/);
});

test('requires credentials', () => {
  assert.throws(() => new XrayClient({ fetch: () => {} }), /Missing Xray credentials/);
});

test('clampLimit keeps values in 1..100', () => {
  assert.strictEqual(clampLimit(500), 100);
  assert.strictEqual(clampLimit(0), 1);
  assert.strictEqual(clampLimit('25'), 25);
});

test('readXray builds jql from key and validates input', async () => {
  const seen = [];
  const client = { getTestExecutions: async (p) => (seen.push(p), { total: 1 }) };
  await readXray(client, { type: 'testExecutions', key: 'ABC-42', limit: '5' });
  assert.deepStrictEqual(seen[0], { jql: 'key = ABC-42', limit: 5 });

  await assert.rejects(readXray(client, { type: 'nope', jql: 'x' }), /Unknown type/);
  await assert.rejects(readXray(client, { type: 'tests' }), /Provide either/);
  await assert.rejects(readXray(client, { key: 'ABC-1 OR 1=1' }), /Invalid issue key/);
});

test('getTests attaches each test\'s runs from its Test Executions', async () => {
  const fetch = mockFetch([
    { status: 200, body: '"t"' },
    {
      status: 200,
      body: {
        data: {
          getTests: {
            total: 2,
            results: [
              { issueId: '100', jira: { key: 'GTP-38660' }, testExecutions: { total: 1, results: [{ issueId: '200' }] } },
              { issueId: '101', jira: { key: 'GTP-38661' }, testExecutions: { total: 0, results: [] } },
            ],
          },
        },
      },
    },
    {
      status: 200,
      body: {
        data: {
          getTestExecutions: {
            total: 1,
            results: [
              {
                issueId: '200',
                testEnvironments: ['UAT'],
                jira: { key: 'GTP-38659', summary: 'UAT run' },
                testRuns: {
                  total: 2,
                  results: [
                    { id: 'r1', status: { name: 'FAILED' }, test: { issueId: '100' } },
                    { id: 'r2', status: { name: 'PASSED' }, test: { issueId: '999' } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  ]);
  const client = new XrayClient({ ...creds, fetch });
  const out = await client.getTests({ jql: 'key = GTP-38660' });

  const runsQuery = JSON.parse(fetch.calls[2].init.body);
  assert.strictEqual(runsQuery.variables.jql, 'issue in (200)');
  assert.strictEqual(out.results[0].testRuns.length, 1);
  assert.strictEqual(out.results[0].testRuns[0].id, 'r1');
  assert.strictEqual(out.results[0].testRuns[0].testExecution.jira.key, 'GTP-38659');
  assert.deepStrictEqual(out.results[0].testRuns[0].testExecution.testEnvironments, ['UAT']);
  assert.deepStrictEqual(out.results[1].testRuns, []);
});

test('getTests skips the run lookup when asked', async () => {
  const fetch = mockFetch([
    { status: 200, body: '"t"' },
    { status: 200, body: { data: { getTests: { total: 1, results: [{ issueId: '1', testExecutions: { results: [{ issueId: '2' }] } }] } } } },
  ]);
  const client = new XrayClient({ ...creds, fetch });
  await client.getTests({ jql: 'x', includeRuns: false });
  assert.strictEqual(fetch.calls.length, 2);
});
