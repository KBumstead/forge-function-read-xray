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

  /** Tests (with steps / gherkin / definition) matching a JQL query. */
  async getTests({ jql, limit = 50, start = 0 }) {
    const data = await this.graphql(
      `query GetTests($jql: String, $limit: Int!, $start: Int) {
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
          }
        }
      }`,
      { jql, limit: clampLimit(limit), start }
    );
    return data.getTests;
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
