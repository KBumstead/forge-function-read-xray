/**
 * Minimal Xray Cloud API client.
 *
 * Xray Cloud API keys are generated per Jira site (Jira > Apps > Xray >
 * Settings > API Keys). Using the API key created on the NPRD site is what
 * makes this client read the NPRD Xray data.
 *
 * Docs: https://docs.getxray.app/display/XRAYCLOUD/REST+API
 *       https://docs.getxray.app/display/XRAYCLOUD/GraphQL+API
 */

const DEFAULT_BASE_URL = 'https://xray.cloud.getxray.app';
// Xray tokens live for 24h; refresh a bit earlier to be safe.
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
// Xray GraphQL caps list queries at 100 results per page.
const MAX_LIMIT = 100;
// Executions looked up when attaching runs to tests (keeps queries small).
const MAX_RUN_LOOKUP_EXECUTIONS = 50;

class XrayError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'XrayError';
    this.status = status;
    this.details = details;
  }
}

class XrayClient {
  /**
   * @param {object} opts
   * @param {string} opts.clientId     Xray API client id (from the NPRD site)
   * @param {string} opts.clientSecret Xray API client secret
   * @param {string} [opts.baseUrl]    Xray Cloud base URL (regional if needed)
   * @param {Function} opts.fetch      fetch implementation (@forge/api fetch)
   */
  constructor({ clientId, clientSecret, baseUrl = DEFAULT_BASE_URL, fetch }) {
    if (!clientId || !clientSecret) {
      throw new XrayError(
        'Missing Xray credentials. Set XRAY_CLIENT_ID and XRAY_CLIENT_SECRET with `forge variables set --encrypt`.',
        500
      );
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetch;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async authenticate() {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    const res = await this.fetch(`${this.baseUrl}/api/v2/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new XrayError(`Xray authentication failed (${res.status})`, res.status, text);
    }

    // The endpoint returns the token as a JSON-encoded string: "eyJ..."
    this.token = JSON.parse(text);
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return this.token;
  }

  async graphql(query, variables = {}) {
    const token = await this.authenticate();
    const res = await this.fetch(`${this.baseUrl}/api/v2/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401) {
      // Token revoked/expired early: drop it so the next call re-authenticates.
      this.token = null;
      this.tokenExpiresAt = 0;
    }

    const text = await res.text();
    if (!res.ok) {
      throw new XrayError(`Xray GraphQL request failed (${res.status})`, res.status, text);
    }

    const json = JSON.parse(text);
    if (json.errors && json.errors.length) {
      throw new XrayError('Xray GraphQL returned errors', 400, json.errors);
    }
    return json.data;
  }

  /**
   * Tests (with steps / gherkin / definition) matching a JQL query.
   *
   * With includeRuns (default), each test also gets `testRuns`: its run in
   * every Test Execution it belongs to (execution key, environments, status).
   * Test runs live on Test Executions, not on the Test issue itself, so they
   * are fetched in a second query.
   */
  async getTests({ jql, limit = 50, start = 0, includeRuns = true, executionLimit = 10 }) {
    const data = await this.graphql(
      `query GetTests($jql: String, $limit: Int!, $start: Int, $execLimit: Int!) {
        getTests(jql: $jql, limit: $limit, start: $start) {
          total
          start
          limit
          results {
            issueId
            testType { name kind }
            folder { path }
            steps { id action data result }
            gherkin
            unstructured
            jira(fields: ["key", "summary", "status", "labels"])
            testExecutions(limit: $execLimit) {
              total
              results { issueId }
            }
          }
        }
      }`,
      { jql, limit: clampLimit(limit), start, execLimit: clampLimit(executionLimit) }
    );
    const tests = data.getTests;
    if (includeRuns) {
      await this.attachTestRuns(tests.results || []);
    }
    return tests;
  }

  /** Adds `testRuns` to each test from the Test Executions it belongs to. */
  async attachTestRuns(tests) {
    const execIds = [
      ...new Set(
        tests.flatMap((t) =>
          ((t.testExecutions && t.testExecutions.results) || []).map((e) => e.issueId)
        )
      ),
    ].slice(0, MAX_RUN_LOOKUP_EXECUTIONS);

    if (!execIds.length) {
      tests.forEach((t) => (t.testRuns = []));
      return;
    }

    // Jira JQL accepts numeric issue ids: issue in (10001, 10002)
    const execs = await this.getTestExecutions({
      jql: `issue in (${execIds.map((id) => Number(id)).filter(Number.isFinite).join(', ')})`,
      limit: execIds.length,
      runLimit: MAX_LIMIT,
    });

    for (const t of tests) {
      t.testRuns = [];
      for (const e of execs.results || []) {
        const runs = (e.testRuns && e.testRuns.results) || [];
        for (const r of runs) {
          if (r.test && String(r.test.issueId) === String(t.issueId)) {
            t.testRuns.push({
              ...r,
              testExecution: {
                issueId: e.issueId,
                testEnvironments: e.testEnvironments,
                jira: e.jira,
              },
            });
          }
        }
      }
    }
  }

  /** Test Executions and their Test Runs (status per test). */
  async getTestExecutions({ jql, limit = 20, start = 0, runLimit = 100 }) {
    const data = await this.graphql(
      `query GetTestExecutions($jql: String, $limit: Int!, $start: Int, $runLimit: Int!) {
        getTestExecutions(jql: $jql, limit: $limit, start: $start) {
          total
          start
          limit
          results {
            issueId
            testEnvironments
            jira(fields: ["key", "summary", "status"])
            testRuns(limit: $runLimit) {
              total
              results {
                id
                status { name color }
                startedOn
                finishedOn
                executedById
                comment
                test {
                  issueId
                  jira(fields: ["key", "summary"])
                }
              }
            }
          }
        }
      }`,
      { jql, limit: clampLimit(limit), start, runLimit: clampLimit(runLimit) }
    );
    return data.getTestExecutions;
  }

  /** Test Plans and the tests they contain. */
  async getTestPlans({ jql, limit = 20, start = 0, testLimit = 100 }) {
    const data = await this.graphql(
      `query GetTestPlans($jql: String, $limit: Int!, $start: Int, $testLimit: Int!) {
        getTestPlans(jql: $jql, limit: $limit, start: $start) {
          total
          start
          limit
          results {
            issueId
            jira(fields: ["key", "summary", "status"])
            tests(limit: $testLimit) {
              total
              results {
                issueId
                testType { name }
                jira(fields: ["key", "summary"])
              }
            }
          }
        }
      }`,
      { jql, limit: clampLimit(limit), start, testLimit: clampLimit(testLimit) }
    );
    return data.getTestPlans;
  }

  /** Test Sets and the tests they contain. */
  async getTestSets({ jql, limit = 20, start = 0, testLimit = 100 }) {
    const data = await this.graphql(
      `query GetTestSets($jql: String, $limit: Int!, $start: Int, $testLimit: Int!) {
        getTestSets(jql: $jql, limit: $limit, start: $start) {
          total
          start
          limit
          results {
            issueId
            jira(fields: ["key", "summary", "status"])
            tests(limit: $testLimit) {
              total
              results {
                issueId
                testType { name }
                jira(fields: ["key", "summary"])
              }
            }
          }
        }
      }`,
      { jql, limit: clampLimit(limit), start, testLimit: clampLimit(testLimit) }
    );
    return data.getTestSets;
  }
}

function clampLimit(n) {
  const v = Number.parseInt(n, 10);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, MAX_LIMIT);
}

module.exports = { XrayClient, XrayError, clampLimit, DEFAULT_BASE_URL };
