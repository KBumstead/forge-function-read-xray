const { XrayError } = require('./xrayClient');

const READERS = {
  tests: (client, p) => client.getTests(p),
  testExecutions: (client, p) => client.getTestExecutions(p),
  testPlans: (client, p) => client.getTestPlans(p),
  testSets: (client, p) => client.getTestSets(p),
};

/**
 * Reads Xray data of the requested type.
 *
 * @param {XrayClient} client
 * @param {object} params
 * @param {'tests'|'testExecutions'|'testPlans'|'testSets'} [params.type='tests']
 * @param {string} [params.jql]   JQL to select issues, e.g. `project = ABC`
 * @param {string} [params.key]   Shortcut for a single issue, e.g. `ABC-123`
 * @param {number} [params.limit]
 * @param {number} [params.start]
 */
async function readXray(client, params = {}) {
  const type = params.type || 'tests';
  const reader = READERS[type];
  if (!reader) {
    throw new XrayError(
      `Unknown type "${type}". Use one of: ${Object.keys(READERS).join(', ')}`,
      400
    );
  }

  let jql = params.jql;
  if (params.key) {
    if (!/^[A-Z][A-Z0-9_]+-\d+$/i.test(params.key)) {
      throw new XrayError(`Invalid issue key "${params.key}"`, 400);
    }
    jql = `key = ${params.key}`;
  }
  if (!jql) {
    throw new XrayError('Provide either "jql" or "key"', 400);
  }

  const query = { jql };
  if (params.limit !== undefined) query.limit = Number(params.limit);
  if (params.start !== undefined) query.start = Number(params.start);

  return reader(client, query);
}

module.exports = { readXray, READERS };
