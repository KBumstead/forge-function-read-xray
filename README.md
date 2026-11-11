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

You can enter the Xray Client ID and Secret in two ways: on the app's
**settings page in Jira** after installing (see
[Admin settings page](#admin-settings-page)), or as Forge variables:

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

### Updating after code changes

`forge install` only installs the version you last deployed, so after any
change (for example, pulling the Rovo tool) you must **deploy first**, then
upgrade the existing install:

```bash
npx forge deploy
```

```bash
npx forge install --upgrade --product jira --site yourcompany-nprd.atlassian.net
```

Forge sometimes updates existing installs automatically after a deploy, but not
always when modules or permissions are added. Running `--upgrade` is harmless
if the install is already up to date.

- Variables you already set (`XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET`, ...) carry
  over between deploys; no need to set them again.
- `npx forge register` is only needed once, before the very first deploy.

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

## Using it in Rovo (connected app tool)

The manifest exposes the reader to Rovo in two parts:

- An **`action`** module (`read-xray-data`, verb `GET`) that runs the Rovo
  handler in `src/rovo.js`.
- A **`rovo:mcp`** module (`Xray Reader`) that lists that action as a tool.
  This is what makes it appear in Rovo Studio under **Connected apps**.

After `forge deploy` and `forge install` (or `forge install --upgrade` if the
app is already installed) on the NPRD site:

1. Open **Rovo Studio** and create or edit an agent.
2. Under tools, go to **Connected apps** and pick **Xray Reader**.
3. Select the **Read Xray test data** tool and click **Add**.

Then ask the agent things like:

- "Show me the steps of test ABC-123"
- "Which tests failed in test execution ABC-42?"
- "List the tests in test plan ABC-10"
- "Find manual tests in project ABC"

Tool inputs (all optional): `type` (`tests`, `testExecutions`, `testPlans`,
`testSets`), `key`, `jql`, `limit` (default 10 for Rovo), `start`. If neither
`key` nor `jql` is given and the user is on a Jira issue, that issue is used.
Results are trimmed to the useful fields (key, summary, status, steps, run
statuses with per-status counts) so Rovo can summarize them.

Notes:

- `rovo:mcp` is a **Preview** Forge module, so Atlassian may still change it.
- Rovo must be enabled on the NPRD site.
- The tool reads Xray with the app's API key, so anyone who can use the agent
  sees whatever that key's Xray user can see.
- Using the tool from external MCP clients (outside Rovo) also needs a site
  admin to turn it on under **Connected apps** in Atlassian Administration.

## Admin settings page

Jira admins can manage the Xray credentials inside Jira, without the CLI:

- **Jira Settings → Apps → Xray Reader settings**, or
- **Jira Settings → Apps → Manage apps → Xray Reader → Configure**

On the page you can:

- Enter the **Client ID** and **Client Secret** and pick the **Xray region**.
- Click **Test connection** to check the key works with Xray, without saving it.
- Click **Save**. The Rovo tool and web trigger use the new key right away;
  no redeploy is needed.
- Click **Remove saved settings** to go back to the Forge variables.

How it behaves:

- Values saved on the page win over the `XRAY_*` Forge variables. If nothing is
  saved on the page, the variables are used, so existing setups keep working.
- The secret is stored with Forge's encrypted secret storage and is never shown
  again. Leave the secret field blank to keep the saved one while changing the
  Client ID or region.
- Only Jira administrators can open the page, and the backend checks admin
  permission again on every call.
- `WEBTRIGGER_SECRET` is still set with `forge variables set`.

This adds the `storage:app` permission, so after deploying, upgrade the
install (`npx forge install --upgrade ...`) and accept the new permission.

## Using the reader from other Forge modules

`src/xrayClient.js` and `src/readXray.js` don't depend on the web trigger. You can
call them from a resolver, scheduled trigger, Rovo action and so on:

```js
const { getClient, readXray } = require('./index');

const runs = await readXray(await getClient(), { type: 'testExecutions', key: 'ABC-42' });
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
manifest.yml          Forge modules (web trigger, Rovo action, rovo:mcp, admin page), Xray egress
src/index.js          Web trigger, Rovo and settings page handlers
src/config.js         Credentials: settings page storage first, then Forge variables
src/settings.js       Settings page backend (admin check, save, test connection)
src/frontend/         Settings page UI (UI Kit)
src/rovo.js           Rovo tool: input handling, trims results for Rovo
src/readXray.js       Reads by type / jql / key, checks the input
src/xrayClient.js     Xray Cloud auth (token cached) + GraphQL queries
test/                 Unit tests (node:test, mocked fetch)
```
