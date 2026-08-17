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

## Remote & OAuth servers (e.g. GitHub)

Downstreams can be **remote** (Streamable HTTP) as well as local. A remote server is `{ "type": "http", "url": "…" }`, and if it needs OAuth, **each user logs in with their own account** — tokens are stored per user at `~/.qualien-mcp/credentials.json` (0600) and are never bundled or shared.

GitHub's hosted MCP is the reference case. It does **not** support dynamic client registration, so you register **your own** GitHub OAuth App once and give qualien-mcp its Client ID:

1. GitHub → Settings → Developer settings → **OAuth Apps** → New. Set the callback URL to `http://127.0.0.1:41999/callback`. Copy the **Client ID**.
2. In `qualien-mcp.config.json`:
   ```json
   {
     "servers": {
       "github": {
         "type": "http",
         "url": "https://api.githubcopilot.com/mcp/",
         "oauth": true,
         "clientId": "<your client id>"
       }
     }
   }
   ```
3. Authorize (opens your browser, once):
   ```bash
   npx qualien-mcp login github
   ```

After that the gateway connects to GitHub non-interactively (refreshing tokens as needed) and exposes `github__*` tools. If a remote server isn't logged in yet, the gateway **skips it with a hint** (`run: npx qualien-mcp login github`) and still serves everything else — it never blocks startup. Servers that *do* support dynamic registration need no `clientId`.

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
