/**
 * The composite gateway. In one process it is BOTH:
 *   - an MCP *server* to the host assistant (over stdio), and
 *   - an MCP *client* to each downstream server (one client per server).
 *
 * Tools/prompts are namespaced `<serverKey>__<name>` (spec-recommended for
 * aggregators — uniqueness is only guaranteed within a single server). tools/list
 * fans out and merges; tools/call routes by the prefix. Resources are routed by a
 * uri→owner map. Everything is passthrough — the gateway adds curation, routing,
 * logging, and lifecycle, not response rewriting.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config, ServerConfig } from "./config.js";
import { log } from "./log.js";

const SEP = "__";

type Downstream = {
  key: string;
  client: Client;
  cfg: ServerConfig;
  transport: StdioClientTransport;
  caps: ServerCapabilities;
};

function toolAllowed(cfg: ServerConfig, name: string): boolean {
  const t = cfg.tools;
  if (!t) return true;
  if (t.deny?.includes(name)) return false;
  if (t.allow && !t.allow.includes(name)) return false;
  return true;
}

/** Connects one downstream. Resolves to null (logged) on failure — never throws,
 *  so one broken server can't take down the whole gateway. */
async function connectDownstream(
  key: string,
  cfg: ServerConfig,
  version: string
): Promise<Downstream | null> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
    stderr: "inherit", // surface the child's own logs in the host's MCP logs
  });
  const client = new Client({ name: `qualien-mcp:${key}`, version }, { capabilities: {} });
  try {
    const t0 = Date.now();
    await client.connect(transport);
    const caps = client.getServerCapabilities() ?? {};
    log.info("downstream_connected", { server: key, ms: Date.now() - t0, capabilities: Object.keys(caps) });
    return { key, client, cfg, transport, caps };
  } catch (e) {
    log.error("downstream_connect_failed", { server: key, error: String(e) });
    try { await transport.close(); } catch { /* ignore */ }
    return null;
  }
}

export async function startGateway(config: Config, version: string): Promise<void> {
  // Connect all enabled downstreams in parallel.
  const entries = Object.entries(config.servers).filter(([, c]) => c.enabled !== false);
  const connected = await Promise.all(entries.map(([key, cfg]) => connectDownstream(key, cfg, version)));
  const downstreams = connected.filter((d): d is Downstream => d !== null);
  const byKey = new Map(downstreams.map((d) => [d.key, d]));

  if (downstreams.length === 0) {
    log.warn("no_downstreams_connected", { configured: entries.map(([k]) => k) });
  }

  // Advertise only the primitives at least one downstream actually supports.
  const capabilities: ServerCapabilities = {};
  if (downstreams.some((d) => d.caps.tools)) capabilities.tools = {};
  if (downstreams.some((d) => d.caps.resources)) capabilities.resources = {};
  if (downstreams.some((d) => d.caps.prompts)) capabilities.prompts = {};

  const server = new Server({ name: "qualien-mcp", version }, { capabilities });

  // The low-level Server rejects a handler for a capability it didn't advertise,
  // so register each primitive's handlers only when a downstream actually offers
  // it (e.g. Playwright + Filesystem are tools-only → no resource/prompt handlers).
  if (capabilities.tools) registerToolHandlers();
  if (capabilities.resources) registerResourceHandlers();
  if (capabilities.prompts) registerPromptHandlers();

  // ---- tools ------------------------------------------------------------- //
  function registerToolHandlers() {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];
    for (const d of downstreams) {
      if (!d.caps.tools) continue;
      try {
        const res = await d.client.listTools();
        for (const tool of res.tools) {
          if (!toolAllowed(d.cfg, tool.name)) continue;
          tools.push({ ...tool, name: `${d.key}${SEP}${tool.name}` });
        }
      } catch (e) {
        log.error("list_tools_failed", { server: d.key, error: String(e) });
      }
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const full = req.params.name;
    const idx = full.indexOf(SEP);
    const key = idx >= 0 ? full.slice(0, idx) : "";
    const bare = idx >= 0 ? full.slice(idx + SEP.length) : full;
    const d = byKey.get(key);
    if (!d) {
      log.warn("route_miss", { tool: full });
      return { content: [{ type: "text", text: `qualien-mcp: no downstream for tool "${full}". Expected "<server>${SEP}<tool>".` }], isError: true };
    }
    if (!toolAllowed(d.cfg, bare)) {
      return { content: [{ type: "text", text: `qualien-mcp: tool "${bare}" is disabled for server "${key}".` }], isError: true };
    }
    const t0 = Date.now();
    try {
      const result = await d.client.callTool({ name: bare, arguments: req.params.arguments ?? {} });
      log.info("tool_call", { server: key, tool: bare, ms: Date.now() - t0, ok: result.isError !== true });
      return result;
    } catch (e) {
      log.error("tool_call_failed", { server: key, tool: bare, ms: Date.now() - t0, error: String(e) });
      return { content: [{ type: "text", text: `qualien-mcp: downstream "${key}" failed calling "${bare}": ${String(e)}` }], isError: true };
    }
  });
  } // registerToolHandlers

  // ---- resources (routed by uri → owner) --------------------------------- //
  function registerResourceHandlers() {
  const ownerByUri = new Map<string, string>();

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [];
    for (const d of downstreams) {
      if (!d.caps.resources) continue;
      try {
        const res = await d.client.listResources();
        for (const r of res.resources) {
          ownerByUri.set(r.uri, d.key);
          resources.push(r);
        }
      } catch (e) {
        log.error("list_resources_failed", { server: d.key, error: String(e) });
      }
    }
    return { resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const resourceTemplates = [];
    for (const d of downstreams) {
      if (!d.caps.resources) continue;
      try {
        const res = await d.client.listResourceTemplates();
        resourceTemplates.push(...res.resourceTemplates);
      } catch { /* server may not support templates */ }
    }
    return { resourceTemplates };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const owner = ownerByUri.get(uri);
    const candidates = owner ? [byKey.get(owner)!] : downstreams.filter((d) => d.caps.resources);
    for (const d of candidates) {
      try {
        const result = await d.client.readResource({ uri });
        log.info("resource_read", { server: d.key, uri });
        return result;
      } catch (e) {
        if (owner) throw e; // known owner failed — surface it
      }
    }
    throw new Error(`qualien-mcp: no downstream served resource "${uri}".`);
  });
  } // registerResourceHandlers

  // ---- prompts (namespaced like tools) ----------------------------------- //
  function registerPromptHandlers() {
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = [];
    for (const d of downstreams) {
      if (!d.caps.prompts) continue;
      try {
        const res = await d.client.listPrompts();
        for (const p of res.prompts) prompts.push({ ...p, name: `${d.key}${SEP}${p.name}` });
      } catch (e) {
        log.error("list_prompts_failed", { server: d.key, error: String(e) });
      }
    }
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const full = req.params.name;
    const idx = full.indexOf(SEP);
    const key = idx >= 0 ? full.slice(0, idx) : "";
    const bare = idx >= 0 ? full.slice(idx + SEP.length) : full;
    const d = byKey.get(key);
    if (!d) throw new Error(`qualien-mcp: no downstream for prompt "${full}".`);
    return d.client.getPrompt({ name: bare, arguments: req.params.arguments });
  });
  } // registerPromptHandlers

  // ---- lifecycle: close every child on shutdown (no orphaned processes) --- //
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown", { signal, closing: downstreams.map((d) => d.key) });
    await Promise.all(downstreams.map((d) => d.client.close().catch(() => {})));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // When the host closes stdin, the stdio transport ends — tear down cleanly.
  transport.onclose = () => void shutdown("stdin-close");

  log.info("gateway_ready", { version, servers: downstreams.map((d) => d.key), capabilities: Object.keys(capabilities) });
}
