#!/usr/bin/env node
/**
 * Builds the MCPB bundle (qualien-mcp-<version>.mcpb) used by Claude Desktop
 * extensions and Smithery: dist + production node_modules + mcpb/entry.js, with
 * the manifest's version and tool list filled from this build.
 *
 *   npm run build && npm run bundle
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "mcpb");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["dist", "package.json", "package-lock.json", "README.md", "LICENSE"]) {
  cpSync(join(root, f), join(out, f), { recursive: true });
}
cpSync(join(root, "mcpb", "entry.js"), join(out, "entry.js"));
cpSync(join(root, "mcpb", "icon.png"), join(out, "icon.png"));
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: out, stdio: "inherit" });

// List the zero-config tools (Playwright + Filesystem) so directories can show them.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(out, "entry.js")],
  cwd: out,
  env: { ...process.env, QUALIEN_MCP_PROJECT_DIR: out },
  stderr: "ignore",
});
const client = new Client({ name: "qualien-mcp-bundle", version: pkg.version });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
manifest.version = pkg.version;
manifest.tools = tools.map((t) => ({ name: t.name, description: (t.description ?? "").split("\n")[0] }));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const file = join(root, "build", `qualien-mcp-${pkg.version}.mcpb`);
execFileSync("npx", ["-y", "@anthropic-ai/mcpb@2", "pack", out, file], { stdio: "inherit" });
console.log(`\n${file} (${tools.length} tools)`);
