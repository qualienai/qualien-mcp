/**
 * Curated catalog of known downstream MCP servers. A user enables any of these by
 * key — just `{ "slack": { "enabled": true, "env": { "SLACK_MCP_XOXP_TOKEN": "…" } } }`
 * — without having to remember the package name or command; qualien-mcp fills in
 * the rest from here. `use` lets you mount a catalog server under a different key.
 *
 * Every entry was verified against npm (real, current, has a `bin`) at authoring
 * time. Where an official reference server was deprecated (postgres, slack,
 * github), a maintained alternative is used. `requires` lists the env/secrets or
 * setup a user must supply (via the server's `env`), surfaced by `qualien-mcp catalog`.
 */
import type { HttpServerConfig, StdioServerConfig } from "./config.js";

export type CatalogConfig = Partial<StdioServerConfig> | Partial<HttpServerConfig>;
export type CatalogEntry = {
  description: string;
  /** Env/secrets/setup the user must provide for this server to work. */
  requires?: string[];
  /** On in the zero-config default? Only the QE starter pair. */
  defaultOn?: boolean;
  config: CatalogConfig;
};

const npx = (...args: string[]): StdioServerConfig => ({ command: "npx", args: ["-y", ...args] });

export const CATALOG: Record<string, CatalogEntry> = {
  // ---- zero-config QE starter pair ----
  playwright: {
    description: "Browser automation, DOM inspection, screenshots — the QE 'eyes'.",
    defaultOn: true,
    config: npx("@playwright/mcp@latest"),
  },
  filesystem: {
    description: "Read/edit project files — page objects, test utils, framework refactors.",
    requires: ["a directory to allow (defaults to the launch cwd)"],
    defaultOn: true,
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()] },
  },

  // ---- remote / OAuth ----
  github: {
    description: "Review code, open PRs, manage issues/test cases — via GitHub's hosted MCP.",
    requires: [
      "your own GitHub OAuth App client id (set `clientId`; callback http://127.0.0.1:41999/callback)",
      "then: qualien-mcp login github",
    ],
    config: { type: "http", url: "https://api.githubcopilot.com/mcp/", oauth: true },
  },

  // ---- reasoning / memory ----
  "sequential-thinking": {
    description: "Structured step-by-step reasoning — debug flaky tests, root-cause analysis.",
    config: npx("@modelcontextprotocol/server-sequential-thinking"),
  },
  memory: {
    description: "Persistent knowledge graph — remember locator patterns, conventions across sessions.",
    config: npx("@modelcontextprotocol/server-memory"),
  },

  // ---- browser diagnostics ----
  "chrome-devtools": {
    description: "Network traffic, console logs, performance, cookies/storage — via Chrome DevTools.",
    config: npx("chrome-devtools-mcp@latest"),
  },

  // ---- databases (verify backend data / API↔DB consistency) ----
  postgres: {
    description: "Run SQL and inspect schema against PostgreSQL — validate backend data.",
    requires: ["env DATABASE_URI (postgres connection string)"],
    config: npx("@henkey/postgres-mcp-server"),
  },
  mysql: {
    description: "Run SQL and inspect schema against MySQL — validate backend data.",
    requires: ["env MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASS, MYSQL_DB"],
    config: npx("@benborla29/mcp-server-mysql"),
  },

  // ---- collaboration / infra / API / design ----
  slack: {
    description: "Read/post Slack — test notifications, triage threads.",
    requires: ["env SLACK_MCP_XOXP_TOKEN (user token) or SLACK_MCP_XOXB_TOKEN (bot token)"],
    config: npx("slack-mcp-server@latest"),
  },
  docker: {
    description: "Manage containers/images — spin up test dependencies (community server).",
    requires: ["a running Docker daemon"],
    config: npx("docker-mcp"),
  },
  kubernetes: {
    description: "Inspect/operate a cluster — kubectl-style, for environment validation.",
    requires: ["a working kubeconfig (KUBECONFIG or ~/.kube/config)"],
    config: npx("mcp-server-kubernetes"),
  },
  openapi: {
    description: "Drive any REST API from its OpenAPI spec — API testing / verification.",
    requires: ["env API_BASE_URL and OPENAPI_SPEC_PATH (or the server's CLI flags)"],
    config: npx("@ivotoby/openapi-mcp-server"),
  },
  jira: {
    description: "Read/update Jira issues — trace tests to tickets, file defects.",
    requires: ["env ATLASSIAN_SITE_NAME, ATLASSIAN_USER_EMAIL, ATLASSIAN_API_TOKEN"],
    config: npx("@aashari/mcp-server-atlassian-jira"),
  },
  figma: {
    description: "Read Figma designs — ground visual/UI tests on the source of truth.",
    requires: ["env FIGMA_API_KEY"],
    config: { command: "npx", args: ["-y", "figma-developer-mcp", "--stdio"] },
  },
};

/** Human-readable listing for the `qualien-mcp catalog` command. */
export function catalogList(): string {
  const lines = ["Available servers (enable in qualien-mcp.config.json by key):", ""];
  for (const [key, e] of Object.entries(CATALOG)) {
    lines.push(`  ${key}${e.defaultOn ? "  (on by default)" : ""}`);
    lines.push(`    ${e.description}`);
    if (e.requires?.length) lines.push(`    requires: ${e.requires.join("; ")}`);
    lines.push("");
  }
  lines.push('Enable one:  { "servers": { "<key>": { "enabled": true, "env": { … } } } }');
  return lines.join("\n");
}
