const { readXray } = require('./readXray');
const { XrayError } = require('./xrayClient');

// Rovo works best with small, focused results.
const DEFAULT_ROVO_LIMIT = 10;

function jiraField(item, name) {
  return item && item.jira ? item.jira[name] : undefined;
}

function statusName(item) {
  const s = jiraField(item, 'status');
  return s && typeof s === 'object' ? s.name : s;
}

function summarizeTest(t) {
  return {
    key: jiraField(t, 'key'),
    summary: jiraField(t, 'summary'),
    status: statusName(t),
    testType: t.testType && t.testType.name,
    folder: t.folder && t.folder.path,
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
  const counts = {};
  for (const r of runs) {
    const name = (r.status && r.status.name) || 'UNKNOWN';
    counts[name] = (counts[name] || 0) + 1;
  }
  return {
    key: jiraField(e, 'key'),
    summary: jiraField(e, 'summary'),
    status: statusName(e),
    testEnvironments: e.testEnvironments,
    totalTestRuns: e.testRuns ? e.testRuns.total : runs.length,
    statusCounts: counts,
    testRuns: runs.map((r) => ({
      test: jiraField(r.test, 'key'),
      testSummary: jiraField(r.test, 'summary'),
      status: r.status && r.status.name,
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
    status: statusName(c),
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

/**
 * Rovo action / MCP tool handler.
 *
 * Rovo passes the action inputs on the payload. If no key or JQL is given and
 * the user is on a Jira issue, that issue is used.
 */
async function rovoReadXray(payload, getClient) {
  const p = payload || {};
  const type = p.type || 'tests';
  let key = p.key;
  const jql = p.jql;

  if (!key && !jql) {
    const issueKey =
      p.context && p.context.jira && p.context.jira.issueKey
        ? p.context.jira.issueKey
        : undefined;
    if (issueKey) key = issueKey;
  }

  try {
    const result = await readXray(getClient(), {
      type,
      key,
      jql: key ? undefined : jql,
      limit: p.limit !== undefined && p.limit !== null ? p.limit : DEFAULT_ROVO_LIMIT,
      start: p.start,
    });
    const summarize = SUMMARIZERS[type];
    return {
      type,
      query: key ? `key = ${key}` : jql,
      total: result.total,
      returned: result.results.length,
      results: result.results.map(summarize),
    };
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
