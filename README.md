# forge-function-read-xray

An Atlassian Forge app with a function that reads **Xray (Cloud)** test data from
your **non-production (NPRD) Jira site**. The function runs behind a web trigger,
so you can call it from scripts, CI pipelines or other services.

It can read:

| `type`           | What it returns                                                      |
| ---------------- | -------------------------------------------------------------------- |
| `tests`          | Tests with type, folder, manual steps, Gherkin / unstructured text   |
| `testExecutions` | Test Executions with their Test Runs (status, timings, comment, test) |
| `testPlans`      | Test Plans and the tests in them                                     |
| `testSets`       | Test Sets and the tests in them                                      |

## How it reaches the NPRD Xray

Xray Cloud data is not in the Jira REST API. It is served by Xray's own API at
`xray.cloud.getxray.app`. Each Jira site has its own Xray API keys, so
**the API key you create on the NPRD site decides which Xray instance is read.**

## Setup

### 1. Create an Xray API key on the NPRD site

On your NPRD Jira (e.g. `yourcompany-nprd.atlassian.net`) go to
**Apps → Xray → Settings → API Keys → Create API Key**. Pick a user who can
browse the projects you want to read. Copy the **Client ID** and **Client Secret**.

### 2. Register, configure and deploy

```bash
npm install
```

```bash
npx forge login
```

```bash
npx forge register
```

```bash
npx forge variables set --encrypt XRAY_CLIENT_ID <client-id>
```

```bash
npx forge variables set --encrypt XRAY_CLIENT_SECRET <client-secret>
```

Optional: require a shared secret on the web trigger. Without it, anyone with
the URL can call the function.

```bash
npx forge variables set --encrypt WEBTRIGGER_SECRET <some-long-random-string>
```

Optional: if your Xray data is in a regional data center, set the base URL
(`https://us.xray.cloud.getxray.app`, `https://eu.xray.cloud.getxray.app` or
`https://au.xray.cloud.getxray.app`):

```bash
npx forge variables set XRAY_BASE_URL https://eu.xray.cloud.getxray.app
```

Deploy and install it on the NPRD site:

```bash
npx forge deploy
```

```bash
npx forge install --product jira --site yourcompany-nprd.atlassian.net
```

Variables are set per Forge environment (`development` by default). Add
`-e staging` or `-e production` to the commands above if you deploy elsewhere.

### 3. Get the web trigger URL

```bash
npx forge webtrigger
```

## Usage

GET with query parameters:

```bash
curl -H "x-api-key: $WEBTRIGGER_SECRET" "$URL?type=tests&jql=project%20%3D%20ABC&limit=20"
```

```bash
curl -H "x-api-key: $WEBTRIGGER_SECRET" "$URL?type=testExecutions&key=ABC-42"
```

Or POST a JSON body:

```bash
curl -X POST -H "x-api-key: $WEBTRIGGER_SECRET" -d '{"type":"testPlans","jql":"project = ABC"}' "$URL"
```

Parameters:

- `type`: `tests` (default), `testExecutions`, `testPlans` or `testSets`
- `jql`: JQL to select the issues; or
- `key`: a single issue key (e.g. `ABC-123`)
- `limit`: page size, 1–100 (Xray's maximum)
- `start`: offset for paging

The response is the Xray GraphQL result, e.g. `{ "total": 3, "start": 0, "limit": 20, "results": [ ... ] }`.

## Using the reader from other Forge modules

`src/xrayClient.js` and `src/readXray.js` don't depend on the web trigger. You can
call them from a resolver, scheduled trigger, Rovo action and so on:

```js
const { getClient, readXray } = require('./index');

const runs = await readXray(getClient(), { type: 'testExecutions', key: 'ABC-42' });
```

## Development

```bash
npm test
```

```bash
npx forge tunnel
```

## Project layout

```
manifest.yml          Forge modules, egress permissions for the Xray API
src/index.js          Web trigger handler
src/readXray.js       Reads by type / jql / key, checks the input
src/xrayClient.js     Xray Cloud auth (token cached) + GraphQL queries
test/                 Unit tests (node:test, mocked fetch)
```
