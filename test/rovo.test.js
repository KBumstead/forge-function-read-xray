const test = require('node:test');
const assert = require('node:assert');
const { rovoReadXray } = require('../src/rovo');
const { XrayError } = require('../src/xrayClient');

function fakeClient(result) {
  const calls = [];
  const handler = (name) => async (p) => {
    calls.push({ name, p });
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    calls,
    getTests: handler('getTests'),
    getTestExecutions: handler('getTestExecutions'),
    getTestPlans: handler('getTestPlans'),
    getTestSets: handler('getTestSets'),
  };
}

test('summarizes tests with steps, defaults limit to 10', async () => {
  const client = fakeClient({
    total: 1,
    results: [
      {
        issueId: '1',
        testType: { name: 'Manual' },
        folder: { path: '/Login' },
        steps: [{ id: 's1', action: 'Open page', data: '', result: 'Page shown' }],
        jira: { key: 'ABC-1', summary: 'Login works', status: { name: 'Done' } },
      },
    ],
  });

  const out = await rovoReadXray({ key: 'ABC-1' }, () => client);

  assert.deepStrictEqual(client.calls[0], { name: 'getTests', p: { jql: 'key = ABC-1', limit: 10 } });
  assert.strictEqual(out.total, 1);
  assert.deepStrictEqual(out.results[0].steps, [
    { step: 1, action: 'Open page', data: undefined, expectedResult: 'Page shown' },
  ]);
  assert.strictEqual(out.results[0].jiraStatus, 'Done');
  assert.strictEqual(out.results[0].latestRunStatus, 'NO RUNS');
  assert.strictEqual(out.results[0].testType, 'Manual');
});

test('summarizes test executions with status counts', async () => {
  const client = fakeClient({
    total: 1,
    results: [
      {
        jira: { key: 'ABC-42', summary: 'Sprint 5 run' },
        testRuns: {
          total: 3,
          results: [
            { status: { name: 'PASSED' }, test: { jira: { key: 'ABC-1' } } },
            { status: { name: 'FAILED' }, test: { jira: { key: 'ABC-2' } }, comment: 'boom' },
            { status: { name: 'PASSED' }, test: { jira: { key: 'ABC-3' } } },
          ],
        },
      },
    ],
  });

  const out = await rovoReadXray({ type: 'testExecutions', key: 'ABC-42' }, () => client);
  const exec = out.results[0];
  assert.deepStrictEqual(exec.statusCounts, { PASSED: 2, FAILED: 1 });
  assert.strictEqual(exec.totalTestRuns, 3);
  assert.strictEqual(exec.testRuns[1].comment, 'boom');
});

test('uses the current Jira issue when no key or jql is given', async () => {
  const client = fakeClient({ total: 0, results: [] });
  await rovoReadXray({ type: 'testPlans', context: { jira: { issueKey: 'ABC-7' } } }, () => client);
  assert.strictEqual(client.calls[0].name, 'getTestPlans');
  assert.strictEqual(client.calls[0].p.jql, 'key = ABC-7');
});

test('key wins over jql', async () => {
  const client = fakeClient({ total: 0, results: [] });
  await rovoReadXray({ key: 'ABC-1', jql: 'project = ABC' }, () => client);
  assert.strictEqual(client.calls[0].p.jql, 'key = ABC-1');
});

test('returns errors as data instead of throwing', async () => {
  const client = fakeClient(new XrayError('Xray authentication failed (401)', 401, 'bad'));
  const out = await rovoReadXray({ key: 'ABC-1' }, () => client);
  assert.deepStrictEqual(out, { error: 'Xray authentication failed (401)', details: 'bad' });

  const out2 = await rovoReadXray({}, () => client);
  assert.match(out2.error, /Provide either/);
});

test('test summary includes runs from its executions and the latest status', async () => {
  const client = fakeClient({
    total: 1,
    results: [
      {
        issueId: '100',
        jira: { key: 'GTP-38660', summary: 'Governance test', status: { name: 'Backlog' } },
        testRuns: [
          {
            status: { name: 'PASSED' },
            startedOn: '2026-11-01T10:00:00Z',
            finishedOn: '2026-11-01T10:05:00Z',
            testExecution: { jira: { key: 'GTP-1', summary: 'Old run' }, testEnvironments: ['SIT'] },
          },
          {
            status: { name: 'FAILED' },
            startedOn: '2026-11-10T10:00:00Z',
            finishedOn: '2026-11-10T10:05:00Z',
            comment: 'Button missing',
            testExecution: { jira: { key: 'GTP-38659', summary: 'UAT run' }, testEnvironments: ['UAT'] },
          },
        ],
      },
    ],
  });

  const out = await rovoReadXray({ type: 'tests', key: 'GTP-38660' }, () => client);
  const t = out.results[0];
  assert.strictEqual(t.jiraStatus, 'Backlog');
  assert.strictEqual(t.latestRunStatus, 'FAILED');
  assert.deepStrictEqual(t.runStatusCounts, { PASSED: 1, FAILED: 1 });
  assert.deepStrictEqual(t.testRuns[1], {
    testExecution: 'GTP-38659',
    testExecutionSummary: 'UAT run',
    testEnvironments: ['UAT'],
    status: 'FAILED',
    startedOn: '2026-11-10T10:00:00Z',
    finishedOn: '2026-11-10T10:05:00Z',
    comment: 'Button missing',
  });
  assert.match(out.note, /jiraStatus is the Jira workflow status/);
});

function routedClient(byCall) {
  const calls = [];
  const make = (name) => async (p) => {
    calls.push({ name, jql: p.jql });
    const r = byCall(name, p.jql);
    return r || { total: 0, results: [] };
  };
  return {
    calls,
    getTests: make('getTests'),
    getTestExecutions: make('getTestExecutions'),
    getTestPlans: make('getTestPlans'),
    getTestSets: make('getTestSets'),
  };
}

test('without a type, a Test Execution key is detected', async () => {
  const client = routedClient((name) =>
    name === 'getTestExecutions'
      ? { total: 1, results: [{ jira: { key: 'GTP-38659' }, testRuns: { total: 1, results: [{ status: { name: 'FAILED' } }] } }] }
      : null
  );
  const out = await rovoReadXray({ key: 'GTP-38659' }, () => client);
  assert.strictEqual(out.matchedAs, 'Test Execution');
  assert.strictEqual(out.type, 'testExecutions');
  assert.deepStrictEqual(out.results[0].statusCounts, { FAILED: 1 });
  assert.deepStrictEqual(client.calls.map((c) => c.name), ['getTests', 'getTestExecutions']);
});

test('without a type, a story key falls back to its linked Tests', async () => {
  const client = routedClient((name, jql) =>
    name === 'getTests' && jql === 'issue in linkedIssues(GTP-100)'
      ? { total: 1, results: [{ jira: { key: 'GTP-38660' }, testRuns: [{ status: { name: 'FAILED' } }] }] }
      : null
  );
  const out = await rovoReadXray({ key: 'GTP-100' }, () => client);
  assert.strictEqual(out.matchedAs, 'Tests linked to GTP-100');
  assert.strictEqual(out.results[0].latestRunStatus, 'FAILED');
  assert.strictEqual(client.calls.length, 5);
});

test('without a type, reports when nothing Xray is found', async () => {
  const client = routedClient(() => null);
  const out = await rovoReadXray({ key: 'GTP-1' }, () => client);
  assert.strictEqual(out.total, 0);
  assert.match(out.note, /no Xray Tests are linked/);
});

test('rejects an invalid key in auto mode', async () => {
  const client = routedClient(() => null);
  const out = await rovoReadXray({ key: 'GTP-1) OR (1=1' }, () => client);
  assert.match(out.error, /Invalid issue key/);
  assert.strictEqual(client.calls.length, 0);
});
