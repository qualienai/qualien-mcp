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

/**
 * Public client id of the "qualien-mcp" GitHub OAuth App. Safe to ship: OAuth
 * client ids are public identifiers, and the device flow needs no secret.
 */
const GITHUB_CLIENT_ID = "Ov23liOwhH56BdRrM1VP";

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
    config: { ...npx("@playwright/mcp@latest"), category: "browser" },
  },
  filesystem: {
    description: "Read/edit project files — page objects, test utils, framework refactors.",
    requires: ["a directory to allow (defaults to the launch cwd)"],
    defaultOn: true,
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      category: "filesystem",
    },
  },

  // ---- remote / OAuth ----
  github: {
    description: "Review code, open PRs, manage issues/test cases — via GitHub's hosted MCP.",
    requires: ["qualien-mcp login github (approve a short code — no OAuth app to register)"],
    config: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      oauth: true,
      // Public client id for the shipped "qualien-mcp" GitHub OAuth App. Client
      // ids are NOT secrets. There is deliberately no clientSecret here: this
      // package is public on npm, so we use the device flow, which is the one
      // grant GitHub allows without a secret. Override with your own app via
      // `clientId` in config, or QUALIEN_MCP_GITHUB_CLIENT_ID.
      clientId: process.env.QUALIEN_MCP_GITHUB_CLIENT_ID ?? GITHUB_CLIENT_ID,
      deviceFlow: {
        deviceAuthorizationUrl: "https://github.com/login/device/code",
        tokenUrl: "https://github.com/login/oauth/access_token",
      },
      scope: "repo read:org",
      category: "remote",
    },
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

  // ---- alternative drivers + device clouds ----
  selenium: {
    description: "Drive a real browser through Selenium WebDriver — for Selenium-based suites.",
    requires: ["a matching browser + driver on PATH (chromedriver/geckodriver)"],
    config: { ...npx("@angiejones/mcp-selenium"), category: "browser" },
  },
  webdriverio: {
    description: "Browser AND native-mobile automation via WebdriverIO.",
    requires: [
      "local browsers need no credentials",
      "for a device cloud, env BROWSERSTACK_USERNAME + BROWSERSTACK_ACCESS_KEY",
    ],
    config: { ...npx("@wdio/mcp"), category: "browser" },
  },
  browserstack: {
    description: "Run against BrowserStack's real browser/device cloud; read test runs.",
    requires: ["env BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY"],
    config: { ...npx("@browserstack/mcp-server"), category: "browser" },
  },

  // ---- productivity / reporting ----
  "ms-365": {
    description: "Excel, Word, Outlook, Teams and SharePoint via Microsoft Graph — test data and reports.",
    requires: [
      "env AZURE_CLIENT_ID and AZURE_TENANT_ID (an Entra app registration)",
      "then sign in when prompted",
    ],
    config: npx("@softeria/ms-365-mcp-server"),
  },
  sentry: {
    description: "Read real user-facing errors and traces — turn production failures into tests.",
    requires: ["a Sentry auth token (the server prompts on first use)"],
    config: npx("@sentry/mcp-server"),
  },

  // ---- browser diagnostics ----
  "chrome-devtools": {
    description: "Network traffic, console logs, performance, cookies/storage — via Chrome DevTools.",
    config: npx("chrome-devtools-mcp@latest"),
  },

  // ---- databases (verify backend data / API↔DB consistency) ----
  postgres: {
    description: "Run SQL and inspect schema against PostgreSQL — validate backend data.",
    requires: ["env DATABASE_URI (postgres connection string)", "read-only by default; set readOnly:false to allow writes"],
    config: { ...npx("@henkey/postgres-mcp-server"), category: "database", readOnly: true },
  },
  mysql: {
    description: "Run SQL and inspect schema against MySQL — validate backend data.",
    requires: ["env MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASS, MYSQL_DB", "read-only by default; set readOnly:false to allow writes"],
    config: { ...npx("@benborla29/mcp-server-mysql"), category: "database", readOnly: true },
  },

  // ---- collaboration / infra / API / design ----
  slack: {
    description: "Read/post Slack — test notifications, triage threads.",
    requires: ["env SLACK_MCP_XOXP_TOKEN (user token) or SLACK_MCP_XOXB_TOKEN (bot token)"],
    config: npx("slack-mcp-server@latest"),
  },
  docker: {
    description: "Manage containers/images — spin up test dependencies (community server).",
    requires: ["a running Docker daemon", "destructive tools blocked by default; set allowDestructive:true to permit"],
    config: { ...npx("docker-mcp"), category: "infra" },
  },
  kubernetes: {
    description: "Inspect/operate a cluster — kubectl-style, for environment validation.",
    requires: ["a working kubeconfig (KUBECONFIG or ~/.kube/config)", "destructive tools blocked by default; set allowDestructive:true to permit"],
    config: { ...npx("mcp-server-kubernetes"), category: "infra" },
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
  confluence: {
    description: "Read/write Confluence pages — test plans, release notes, living docs.",
    // Same credential trio as jira: one Atlassian API token covers both.
    requires: ["env ATLASSIAN_SITE_NAME, ATLASSIAN_USER_EMAIL, ATLASSIAN_API_TOKEN"],
    config: npx("@aashari/mcp-server-atlassian-confluence"),
  },
  "azure-devops": {
    description: "Work items, repos, pipelines and test plans in Azure DevOps.",
    requires: [
      "your ADO organization name as the last arg: " +
        '{ "azure-devops": { "enabled": true, "args": ["-y", "@azure-devops/mcp", "my-org"] } }',
      "sign in when prompted, or add \"--authentication\", \"azcli\" to args and run `az login`",
    ],
    // Microsoft's official server. The org is positional, so the placeholder is
    // spelled out rather than left blank — a wrong org fails clearly.
    config: npx("@azure-devops/mcp", "YOUR_ADO_ORG"),
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
