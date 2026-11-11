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
  assert.strictEqual(out.results[0].status, 'Done');
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
