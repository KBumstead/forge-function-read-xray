const { readXray, isValidIssueKey } = require('./readXray');
const { XrayError } = require('./xrayClient');

// Rovo works best with small, focused results.
const DEFAULT_ROVO_LIMIT = 10;

function jiraField(item, name) {
  return item && item.jira ? item.jira[name] : undefined;
}

/** Jira workflow status (e.g. Backlog, Done). NOT an Xray test run result. */
function jiraStatus(item) {
  const s = jiraField(item, 'status');
  return s && typeof s === 'object' ? s.name : s;
}

function runStatus(r) {
  return (r && r.status && r.status.name) || 'UNKNOWN';
}

function countStatuses(runs) {
  const counts = {};
  for (const r of runs) {
    const name = runStatus(r);
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

function runTime(r) {
  const t = Date.parse(r.finishedOn || r.startedOn || '');
  return Number.isFinite(t) ? t : -Infinity;
}

function summarizeTest(t) {
  const runs = t.testRuns || [];
  const latest = runs.length
    ? runs.reduce((a, b) => (runTime(b) >= runTime(a) ? b : a))
    : undefined;
  return {
    key: jiraField(t, 'key'),
    summary: jiraField(t, 'summary'),
    jiraStatus: jiraStatus(t),
    testType: t.testType && t.testType.name,
    folder: t.folder && t.folder.path,
    // Xray execution results for this test, one per Test Execution.
    latestRunStatus: latest ? runStatus(latest) : 'NO RUNS',
    runStatusCounts: countStatuses(runs),
    testRuns: runs.map((r) => ({
      testExecution: jiraField(r.testExecution, 'key'),
      testExecutionSummary: jiraField(r.testExecution, 'summary'),
      testEnvironments: r.testExecution && r.testExecution.testEnvironments,
      status: runStatus(r),
      startedOn: r.startedOn,
      finishedOn: r.finishedOn,
      comment: r.comment || undefined,
    })),
    steps: (t.steps || []).map((s, i) => ({
      step: i + 1,
      action: s.action,
      data: s.data || undefined,
      expectedResult: s.result,
    })),
    gherkin: t.gherkin || undefined,
    definition: t.unstructured || undefined,
  };
}

function summarizeExecution(e) {
  const runs = (e.testRuns && e.testRuns.results) || [];
  return {
    key: jiraField(e, 'key'),
    summary: jiraField(e, 'summary'),
    jiraStatus: jiraStatus(e),
    testEnvironments: e.testEnvironments,
    totalTestRuns: e.testRuns ? e.testRuns.total : runs.length,
    statusCounts: countStatuses(runs),
    testRuns: runs.map((r) => ({
      test: jiraField(r.test, 'key'),
      testSummary: jiraField(r.test, 'summary'),
      status: runStatus(r),
      startedOn: r.startedOn,
      finishedOn: r.finishedOn,
      comment: r.comment || undefined,
    })),
  };
}

function summarizeContainer(c) {
  const tests = (c.tests && c.tests.results) || [];
  return {
    key: jiraField(c, 'key'),
    summary: jiraField(c, 'summary'),
    jiraStatus: jiraStatus(c),
    totalTests: c.tests ? c.tests.total : tests.length,
    tests: tests.map((t) => ({
      key: jiraField(t, 'key'),
      summary: jiraField(t, 'summary'),
      testType: t.testType && t.testType.name,
    })),
  };
}

const SUMMARIZERS = {
  tests: summarizeTest,
  testExecutions: summarizeExecution,
  testPlans: summarizeContainer,
  testSets: summarizeContainer,
};

const NOTE =
  'jiraStatus is the Jira workflow status of the issue. Test results are in ' +
  'testRuns / latestRunStatus / statusCounts (PASSED, FAILED, TODO, EXECUTING, ABORTED).';

/**
 * When no type is given for an issue key, try what the issue is, in order:
 * a Test, Test Execution, Test Plan or Test Set; otherwise the Tests linked
 * to it (e.g. a story whose tests cover it).
 */
function autoAttempts(key) {
  return [
    { type: 'tests', jql: `key = ${key}`, matchedAs: 'Test' },
    { type: 'testExecutions', jql: `key = ${key}`, matchedAs: 'Test Execution' },
    { type: 'testPlans', jql: `key = ${key}`, matchedAs: 'Test Plan' },
    { type: 'testSets', jql: `key = ${key}`, matchedAs: 'Test Set' },
    {
      type: 'tests',
      jql: `issue in linkedIssues(${key})`,
      matchedAs: `Tests linked to ${key}`,
    },
  ];
}

function format(type, query, result, matchedAs) {
  return {
    type,
    matchedAs,
    query,
    total: result.total,
    returned: result.results.length,
    note: NOTE,
    results: result.results.map(SUMMARIZERS[type]),
  };
}

/**
 * Rovo action / MCP tool handler.
 *
 * Rovo passes the action inputs on the payload. If no key or JQL is given and
 * the user is on a Jira issue, that issue is used. If no type is given for a
 * key, the issue type is detected (see autoAttempts).
 */
async function rovoReadXray(payload, getClient) {
  const p = payload || {};
  let key = p.key ? String(p.key).trim() : undefined;
  const jql = p.jql;

  if (!key && !jql) {
    const issueKey =
      p.context && p.context.jira && p.context.jira.issueKey
        ? p.context.jira.issueKey
        : undefined;
    if (issueKey) key = issueKey;
  }

  const limit = p.limit !== undefined && p.limit !== null ? p.limit : DEFAULT_ROVO_LIMIT;

  try {
    const client = await getClient();

    if (!p.type && key) {
      if (!isValidIssueKey(key)) {
        throw new XrayError(`Invalid issue key "${key}"`, 400);
      }
      for (const attempt of autoAttempts(key)) {
        const result = await readXray(client, {
          type: attempt.type,
          jql: attempt.jql,
          limit,
          start: p.start,
        });
        if (result.total > 0) {
          return format(attempt.type, attempt.jql, result, attempt.matchedAs);
        }
      }
      return {
        matchedAs: 'nothing',
        query: key,
        total: 0,
        returned: 0,
        note: `${key} is not an Xray Test, Test Execution, Test Plan or Test Set, and no Xray Tests are linked to it.`,
        results: [],
      };
    }

    const type = p.type || 'tests';
    const result = await readXray(client, {
      type,
      key,
      jql: key ? undefined : jql,
      limit,
      start: p.start,
    });
    return format(type, key ? `key = ${key}` : jql, result, undefined);
  } catch (err) {
    console.error('rovo read-xray failed', err.message, err.details || '');
    // Return the error as data so Rovo can explain it to the user.
    return {
      error: err.message,
      details: err instanceof XrayError ? err.details : undefined,
    };
  }
}

module.exports = { rovoReadXray, summarizeTest, summarizeExecution, summarizeContainer };
