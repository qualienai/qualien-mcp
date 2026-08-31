# qualien-mcp

A **composite MCP gateway** — it aggregates multiple [Model Context Protocol](https://modelcontextprotocol.io) servers behind **one** connection, curated for **SDET / QE** workflows. Add one server to your AI assistant instead of five.

```bash
npx qualien-mcp
```

Out of the box it serves the **QE starter pair** — [Playwright MCP](https://github.com/microsoft/playwright-mcp) (browser automation, DOM, screenshots) and [Filesystem MCP](https://github.com/modelcontextprotocol/servers) (read/edit project files, page objects, test utils) — with zero config. Tools are exposed to your assistant namespaced as `playwright__…` and `filesystem__…`.

## Why a gateway?

Your assistant can already connect to many MCP servers directly — so a gateway earns its place by doing what a pile of servers can't:

- **One endpoint** to add to any client (Claude Code, Claude Desktop, Cursor, …).
- **Curation** — enable/disable per server *and* per tool. Fewer, better-named tools = better tool-selection by the model (dumping 200 tools at it makes it *worse*).
- **One routing/logging surface** — every call is logged to stderr with the downstream, tool, and latency.
- **Clean lifecycle** — spawns each downstream as a child process and tears them **all** down on exit (no orphaned browser processes).
- **Curated for QE** — an opinionated SDET toolkit, not a generic proxy.

## Use it with your assistant

**Claude Code** (`.mcp.json` or user settings):

```json
{
  "mcpServers": {
    "qualien": { "command": "npx", "args": ["-y", "qualien-mcp"] }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`) — same shape under `mcpServers`.

That single entry gives your assistant every tool from every aggregated server.

## Add more servers

Drop a `qualien-mcp.config.json` in your working directory (or pass `--config <path>`). Entries **merge over** the built-in defaults — redefine a key to change it, or set `enabled: false` to turn a default off. No new release needed.

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/abs/path/to/allow"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "tools": { "deny": ["browser_close"] }
    }
  }
}
```

See [`qualien-mcp.config.example.json`](./qualien-mcp.config.example.json) for the full shape (`command`, `args`, `env`, `enabled`, `tools.allow` / `tools.deny`).

### Built-in catalog

qualien-mcp ships a curated catalog of 21 known servers (each verified against npm), so you enable one by **key** with just your secrets — no need to remember packages or commands:

```json
{
  "servers": {
    "chrome-devtools": { "enabled": true },
    "postgres":  { "enabled": true, "env": { "DATABASE_URI": "postgres://…" } },
    "slack":     { "enabled": true, "env": { "SLACK_MCP_XOXP_TOKEN": "xoxp-…" } }
  }
}
```

Run `npx qualien-mcp catalog` to list them all with what each needs. Current catalog:

| Key | What | Needs |
|---|---|---|
| `playwright` *(default)* | Browser automation, DOM, screenshots | — |
| `filesystem` *(default)* | Read/edit project files | a dir to allow (default cwd) |
| `github` | PRs, issues, code review | `login github` (see below) |
| `sequential-thinking` | Structured reasoning / debugging | — |
| `memory` | Persistent knowledge graph | — |
| `chrome-devtools` | Network, console, perf, storage | — |
| `postgres` | SQL / validate backend data | `DATABASE_URI` |
| `mysql` | SQL / validate backend data | MySQL env |
| `slack` | Read/post Slack | `SLACK_MCP_XOXP_TOKEN` |
| `docker` | Manage containers | Docker daemon |
| `kubernetes` | Inspect/operate a cluster | kubeconfig |
| `openapi` | Drive any REST API from its spec | `API_BASE_URL`, `OPENAPI_SPEC_PATH` |
| `jira` | Read/update Jira issues | Atlassian API token env |
| `figma` | Read Figma designs | `FIGMA_API_KEY` |
| `confluence` | Test plans, release notes, living docs | Atlassian API token env |
| `azure-devops` | Work items, repos, pipelines, test plans | your ADO org as an arg + sign-in |
| `selenium` | Drive a browser via Selenium WebDriver | a browser + driver on PATH |
| `webdriverio` | Browser **and** native-mobile automation | — (cloud creds optional) |
| `browserstack` | Real browser/device cloud; read test runs | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` |
| `ms-365` | Excel, Word, Outlook, Teams, SharePoint | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` |
| `sentry` | Real user-facing errors → new tests | a Sentry auth token |

`use` mounts a catalog server under a different key (e.g. two databases): `{ "db-prod": { "use": "postgres", "enabled": true, "env": {…} } }`. Anything not in the catalog you still define in full (`command`/`args` or `type`/`url`).

## Remote & OAuth servers (e.g. GitHub)

Downstreams can be **remote** (Streamable HTTP) as well as local. A remote server is `{ "type": "http", "url": "…" }`, and if it needs OAuth, **each user logs in with their own account** — tokens are stored per user at `~/.qualien-mcp/credentials.json` (0600), on that user's own machine, and are never bundled, shared, or sent anywhere by qualien-mcp.

GitHub's hosted MCP is the reference case, and it needs no setup beyond one command:

1. Turn it on in `qualien-mcp.config.json`:
   ```json
   { "servers": { "github": { "enabled": true } } }
   ```
2. Authorize once:
   ```bash
   npx qualien-mcp login github
   ```

`login` prints a short code and a URL; you approve it on github.com and you're done. There is no OAuth App to register and no client secret anywhere.

<details>
<summary>Why the device flow?</summary>

GitHub requires a `client_secret` to exchange an authorization code — [PKCE does not lift that](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app), because GitHub does not distinguish public from confidential clients. qualien-mcp ships on npm, so a secret in the package would be a *published* secret. The [device flow](https://datatracker.ietf.org/doc/html/rfc8628) is the one grant GitHub allows without a secret, and it's the grant GitHub recommends for CLIs. So qualien-mcp ships only a **public client id** — an identifier, not a credential — and every user's tokens are minted on, and stay on, their own machine.

</details>

To use **your own** GitHub OAuth App instead of the shipped one, set `clientId` (and enable the device flow on it under *Settings → Developer settings → OAuth Apps*):

```json
{
  "servers": {
    "github": { "clientId": "<your client id>", "enabled": true }
  }
}
```

If a remote server isn't logged in yet, the gateway **skips it with a hint** (`run: npx qualien-mcp login github`) and still serves everything else — it never blocks startup. Servers that support dynamic client registration need no `clientId` at all.

## Safe by default

qualien-mcp enforces guardrails **centrally, before forwarding a call** — so they hold no matter what the downstream permits, and composite tools can't bypass them either:

- **Databases are read-only** — `postgres`/`mysql` calls containing write/DDL SQL (`INSERT/UPDATE/DELETE/DROP/…`) are refused. Opt in with `{ "postgres": { "readOnly": false } }`.
- **Filesystem roots** — `{ "filesystem": { "roots": ["./src", "./tests"] } }` refuses any call whose path argument escapes those directories.
- **Destructive infra tools blocked** — `docker`/`kubernetes` tools whose name looks destructive (`delete/remove/prune/kill/…`) are refused unless `{ "allowDestructive": true }`.
- Plus per-server **`tools.deny` / `tools.allow`** curation.

> Honest scope: these stop an LLM from *accidentally* doing damage. The SQL check is keyword-based (heuristic), not a parser — it is **not** adversarial sandboxing. Real isolation needs the downstream's own permissions or a container.

## Composite QE tools

Beyond passthrough, qualien-mcp ships tools it implements itself (namespace `qe__`) that orchestrate several downstreams in one call — the QE payoff of a gateway.

**`qe__verify_api_vs_db`** — end-to-end API↔DB consistency in one call. Give it two sub-calls (namespaced tools you can discover via `tools/list`); it runs both and diffs the payloads:

```jsonc
{
  "api": { "tool": "openapi__getUser", "arguments": { "id": 1 } },
  "db":  { "tool": "postgres__query", "arguments": { "sql": "select id, name from users where id = 1" } },
  "match": "subset"        // every field the DB returns must match the API (default)
}
// → { "match": false, "differences": [ { "path": "name", "api": "Ann", "db": "Bob" } ], … }
```

Composite tools appear only when their required downstreams are connected (`qe__verify_api_vs_db` needs a `database` server). More to come (repro-from-Jira, page-object-from-URL, flaky triage).

## How it works

In one process, qualien-mcp is **both** an MCP *server* to your assistant and an MCP *client* to each downstream:

```
assistant ⇄ qualien-mcp ⇄ playwright-mcp
                         ⇄ filesystem-mcp
                         ⇄ …
```

- `tools/list` fans out to every downstream, filters by your curation rules, and namespaces each as `<server>__<tool>`.
- `tools/call` routes by that prefix to the owning server and passes the response straight through.
- Resources and prompts are aggregated the same way when a downstream provides them.
- A downstream that fails to start is logged and **skipped** — the gateway still serves the rest.
- Logs go to **stderr** (stdout is the protocol); your host surfaces them in its MCP logs.

## Roadmap

- v0.1 — Playwright + Filesystem, namespacing, curation, logging, clean lifecycle ✅
- Next — config-driven expansion (GitHub via its hosted OAuth MCP, DB, Sequential-Thinking, Memory, Chrome DevTools), composite QE tools (e.g. verify API ↔ DB consistency in one call), safety scoping.

## License

MIT
