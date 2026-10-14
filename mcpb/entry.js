#!/usr/bin/env node
/**
 * Entry point for the MCPB bundle (Claude Desktop extensions, Smithery). Starts
 * the gateway inside the project folder the user picked at install time, so the
 * Filesystem server is scoped to that folder and a qualien-mcp.config.json there
 * is picked up, exactly as `npx qualien-mcp` does when run from a project.
 */
import { existsSync, statSync } from "node:fs";

const dir = process.env.QUALIEN_MCP_PROJECT_DIR;
// An unset user_config value may arrive empty or as the raw "${...}" placeholder.
// Refuse to start then: the host's cwd can be "/", which would open the whole disk.
if (!dir || dir.startsWith("${") || !existsSync(dir) || !statSync(dir).isDirectory()) {
  process.stderr.write(`qualien-mcp: pick a project folder in the extension settings (got "${dir ?? ""}").\n`);
  process.exit(1);
}
process.chdir(dir);

await import("./dist/index.js");
