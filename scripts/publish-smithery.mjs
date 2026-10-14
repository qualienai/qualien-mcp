#!/usr/bin/env node
/**
 * Publishes build/qualien-mcp-<version>.mcpb to Smithery as qualienai/qualien-mcp.
 *
 *   npm run build && npm run bundle && npm run publish:smithery
 *
 * Why not `smithery mcp publish <bundle>`: Smithery's server card needs an
 * inputSchema for every tool, but the MCPB manifest schema rejects that key, so
 * the CLI's upload fails validation. This sends the same release to the same
 * API with the tool list read live from the bundle, schemas included.
 *
 * Auth: SMITHERY_API_KEY, or the key `npx @smithery/cli auth login` saved.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const NAME = "qualienai/qualien-mcp";
const API = `https://api.smithery.ai/servers/${encodeURIComponent(NAME)}`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(root, "build", "mcpb");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const bundleFile = join(root, "build", `qualien-mcp-${pkg.version}.mcpb`);
if (!existsSync(bundleFile)) {
  throw new Error(`${bundleFile} not found. Run: npm run build && npm run bundle`);
}
const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));

function apiKey() {
  if (process.env.SMITHERY_API_KEY) return process.env.SMITHERY_API_KEY;
  const candidates = [
    join(homedir(), "Library", "Application Support", "smithery", "settings.json"),
    join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "smithery", "settings.json"),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "smithery", "settings.json"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      const key = JSON.parse(readFileSync(file, "utf8")).apiKey;
      if (key) return key;
    }
  }
  throw new Error("No Smithery key. Run `npx @smithery/cli auth login` or set SMITHERY_API_KEY.");
}
const auth = { Authorization: `Bearer ${apiKey()}` };

async function call(method, url, init = {}) {
  const res = await fetch(url, { method, ...init, headers: { ...auth, ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

// The tools the bundle serves with zero config, with their input schemas.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(bundleDir, "entry.js")],
  cwd: bundleDir,
  env: { ...process.env, QUALIEN_MCP_PROJECT_DIR: bundleDir },
  stderr: "ignore",
});
const client = new Client({ name: "qualien-mcp-publish", version: pkg.version });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const projectDir = manifest.user_config.project_dir;
const payload = {
  type: "stdio",
  runtime: "node",
  serverCard: {
    serverInfo: { name: manifest.name, version: manifest.version },
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  },
  configSchema: {
    type: "object",
    properties: { project_dir: { type: "string", title: projectDir.title, description: projectDir.description } },
    required: ["project_dir"],
  },
};

const lookup = await fetch(API, { headers: auth });
if (lookup.status === 404) {
  await call("PUT", API, { headers: { "Content-Type": "application/json" }, body: "{}" });
  console.log(`Created ${NAME}`);
} else if (!lookup.ok) {
  throw new Error(`GET ${API} → ${lookup.status} ${(await lookup.text()).slice(0, 500)}`);
}

const form = new FormData();
form.append("payload", JSON.stringify(payload));
form.append("bundle", new Blob([readFileSync(bundleFile)]), "server.mcpb");
const release = await call("PUT", `${API}/releases`, { body: form });
console.log(`Release ${release.deploymentId}: ${release.status} (${tools.length} tools, v${pkg.version})`);

await call("PATCH", API, {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ displayName: manifest.name, description: manifest.long_description, homepage: manifest.homepage }),
});
const icon = new FormData();
icon.append("icon", new Blob([readFileSync(join(bundleDir, "icon.png"))], { type: "image/png" }), "icon.png");
await call("PUT", `${API}/icon`, { body: icon });
console.log(`https://smithery.ai/servers/${NAME}`);
