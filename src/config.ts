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
import { log } from "./log.js";

export type ServerConfig = {
  /** Executable to spawn (e.g. "npx"). */
  command: string;
  /** Arguments (e.g. ["-y", "@playwright/mcp@latest"]). */
  args?: string[];
  /** Extra env for the child (merged over the inherited environment). */
  env?: Record<string, string>;
  /** Set false to keep a server configured but off. Default: on. */
  enabled?: boolean;
  /** Tool curation for this server — fewer tools = better host tool-selection. */
  tools?: { allow?: string[]; deny?: string[] };
};

export type Config = { servers: Record<string, ServerConfig> };

/** The zero-config QE starter pair — both stdio npx servers, no auth needed. */
export function defaultConfig(): Config {
  return {
    servers: {
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
        enabled: true,
      },
      filesystem: {
        // Root defaults to the directory the gateway is launched from.
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
        enabled: true,
      },
    },
  };
}

function configPathFromArgv(argv: string[]): string | null {
  const i = argv.indexOf("--config");
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  const local = resolve(process.cwd(), "qualien-mcp.config.json");
  return existsSync(local) ? local : null;
}

/**
 * Default config, with any user config file merged on top (per-server key, user
 * wins) — so a user can add servers, or disable a default with `enabled: false`.
 * A malformed config file is a hard error: silently falling back to defaults
 * would hide the user's mistake.
 */
export function loadConfig(argv: string[]): Config {
  const config = defaultConfig();
  const path = configPathFromArgv(argv);
  if (!path) {
    log.info("config_default", { servers: Object.keys(config.servers) });
    return config;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Couldn't read/parse config ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const servers = (parsed as Config)?.servers;
  if (!servers || typeof servers !== "object") {
    throw new Error(`Config ${path} must have a top-level "servers" object.`);
  }
  for (const [key, cfg] of Object.entries(servers)) {
    if (!cfg || typeof (cfg as ServerConfig).command !== "string") {
      throw new Error(`Config server "${key}" needs a "command" string.`);
    }
    config.servers[key] = cfg as ServerConfig;
  }
  log.info("config_loaded", { path, servers: Object.keys(config.servers) });
  return config;
}
