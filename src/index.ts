#!/usr/bin/env node
/**
 * qualien-mcp — a composite MCP gateway. Aggregates multiple downstream MCP
 * servers behind one stdio connection, curated for SDET/QE workflows.
 *
 *   npx qualien-mcp                 # zero-config: Playwright + Filesystem
 *   npx qualien-mcp --config x.json # aggregate whatever you list
 */
import { createRequire } from "node:module";
import { catalogList } from "./catalog.js";
import { loadConfig } from "./config.js";
import { startGateway } from "./gateway.js";
import { runLogin } from "./login.js";
import { log } from "./log.js";

const require = createRequire(import.meta.url);
const version: string = require("../package.json").version;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(
      `qualien-mcp v${version}\n` +
        `A composite MCP gateway for SDET/QE — aggregates many MCP servers behind one connection.\n\n` +
        `Usage:\n` +
        `  qualien-mcp [--config <path>]      run the gateway (stdio)\n` +
        `  qualien-mcp catalog                list the built-in servers you can enable\n` +
        `  qualien-mcp login <server>         authorize a remote OAuth server (e.g. github)\n\n` +
        `With no config it serves the QE starter pair (Playwright + Filesystem).\n` +
        `Add a qualien-mcp.config.json (cwd) or pass --config to aggregate more.\n`
    );
    return;
  }

  // `catalog` — list the curated servers a user can enable by key.
  if (argv[0] === "catalog") {
    process.stderr.write(catalogList() + "\n");
    return;
  }

  // `login <server>` — interactive OAuth for a remote server, run once per user.
  if (argv[0] === "login") {
    const key = argv[1];
    if (!key) {
      process.stderr.write("usage: qualien-mcp login <server>\n");
      process.exitCode = 1;
      return;
    }
    await runLogin(key, loadConfig(argv), version);
    return;
  }

  const config = loadConfig(argv);
  await startGateway(config, version);
}

main().catch((e) => {
  log.error("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
