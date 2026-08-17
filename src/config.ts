/**
 * Configuration: which downstream MCP servers to aggregate. Ships with a
 * zero-config default (the QE starter pair: Playwright + Filesystem) so
 * `npx qualien-mcp` just works. Users extend it with a `qualien-mcp.config.json`
 * (in cwd, or via `--config <path>`) — added servers merge over the defaults, so
 * new stacks/platforms need no new release. That merge IS the whole extensibility
 * story behind "aggregate any MCP server".
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CATALOG } from "./catalog.js";
import { log } from "./log.js";

/** Curation + on/off common to every server kind. */
type CommonConfig = {
  /** Set false to keep a server configured but off. Default: on. */
  enabled?: boolean;
  /** Tool curation for this server — fewer tools = better host tool-selection. */
  tools?: { allow?: string[]; deny?: string[] };
};

/** A local server spawned over stdio (e.g. `npx @playwright/mcp`). */
export type StdioServerConfig = CommonConfig & {
  /** Executable to spawn (e.g. "npx"). */
  command: string;
  /** Arguments (e.g. ["-y", "@playwright/mcp@latest"]). */
  args?: string[];
  /** Extra env for the child (merged over the inherited environment). */
  env?: Record<string, string>;
};

/**
 * A remote server reached over Streamable HTTP (e.g. GitHub's hosted MCP at
 * https://api.githubcopilot.com/mcp/). With `oauth: true` each USER logs in with
 * their OWN account via `qualien-mcp login <server>` — tokens are stored per user
 * at ~/.qualien-mcp/credentials.json, never shared or bundled.
 */
export type HttpServerConfig = CommonConfig & {
  type: "http";
  /** The MCP endpoint URL. */
  url: string;
  /** Run the OAuth authorization-code flow for this server. */
  oauth?: boolean;
  /**
   * Pre-registered OAuth client id. REQUIRED for servers that don't support
   * dynamic client registration (e.g. GitHub) — the user registers their own
   * OAuth app (callback http://127.0.0.1:41999/callback) and puts its id here.
   * Omit it for servers that support DCR (qualien-mcp registers automatically).
   */
  clientId?: string;
  /** OAuth client secret, only for "confidential" apps that require one. */
  clientSecret?: string;
  /** OAuth scope string to request (space-separated), if the server needs one. */
  scope?: string;
  /** Static headers (e.g. a personal access token) for non-OAuth remotes. */
  headers?: Record<string, string>;
};

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export function isHttp(c: ServerConfig): c is HttpServerConfig {
  return (c as HttpServerConfig).type === "http" || typeof (c as HttpServerConfig).url === "string";
}

export type Config = { servers: Record<string, ServerConfig> };

/**
 * A server entry as WRITTEN in a config file: everything optional (so you can
 * just flip `{ "enabled": true }` on a catalog server), plus `use` to mount a
 * catalog server under a different key. Resolved to a full ServerConfig against
 * the CATALOG before use.
 */
export type RawServerConfig = Partial<StdioServerConfig & HttpServerConfig> & { use?: string };

/** The zero-config default: the QE starter pair, resolved from the catalog. */
function defaultRawServers(): Record<string, RawServerConfig> {
  const out: Record<string, RawServerConfig> = {};
  for (const [key, entry] of Object.entries(CATALOG)) {
    if (entry.defaultOn) out[key] = { enabled: true };
  }
  return out;
}

function configPathFromArgv(argv: string[]): string | null {
  const i = argv.indexOf("--config");
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  const local = resolve(process.cwd(), "qualien-mcp.config.json");
  return existsSync(local) ? local : null;
}

/** Fill a raw entry's command/url from the catalog (its own key, or `use`); the
 *  user's own fields always win over the catalog's. */
function resolveServer(key: string, raw: RawServerConfig): ServerConfig {
  const base = (CATALOG[raw.use ?? key]?.config ?? {}) as RawServerConfig;
  const merged: RawServerConfig = { ...base, ...raw };
  delete merged.use;
  return merged as ServerConfig;
}

/**
 * Builds the effective config: the default QE pair, plus any servers from the
 * user's config file (merged per key), each resolved against the catalog. A
 * malformed config file is a hard error — silently falling back would hide the
 * user's mistake.
 */
export function loadConfig(argv: string[]): Config {
  const raw = defaultRawServers();
  const path = configPathFromArgv(argv);
  if (path) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`Couldn't read/parse config ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const servers = (parsed as { servers?: Record<string, RawServerConfig> })?.servers;
    if (!servers || typeof servers !== "object") {
      throw new Error(`Config ${path} must have a top-level "servers" object.`);
    }
    for (const [key, cfg] of Object.entries(servers)) raw[key] = { ...(raw[key] ?? {}), ...cfg };
    log.info("config_loaded", { path, servers: Object.keys(raw) });
  } else {
    log.info("config_default", { servers: Object.keys(raw) });
  }

  const out: Record<string, ServerConfig> = {};
  for (const [key, r] of Object.entries(raw)) {
    const resolved = resolveServer(key, r);
    const hasCommand = typeof (resolved as StdioServerConfig).command === "string";
    if (!hasCommand && !isHttp(resolved)) {
      throw new Error(
        `Server "${key}" needs a "command", a "url", or a "use": "<catalog key>". ` +
          `Known catalog keys: ${Object.keys(CATALOG).join(", ")}.`
      );
    }
    out[key] = resolved;
  }
  return { servers: out };
}
