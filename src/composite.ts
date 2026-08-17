/**
 * Composite QE tools — tools the GATEWAY itself implements (namespace `qe__`) by
 * orchestrating several downstreams in one call. This is the one place qualien-mcp
 * does real work instead of passthrough, and it's the QE differentiation: the host
 * makes one call and gets an end-to-end result instead of juggling 3-4 tools.
 *
 * v1 ships `qe__verify_api_vs_db`: call an API tool and a DB tool, then diff the
 * two payloads and report a single verdict.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type CompositeContext = {
  /** True if a connected downstream has the given category. */
  hasCategory(category: string): boolean;
  /** True if a connected downstream has the given key. */
  hasServer(key: string): boolean;
  /** Route a namespaced tool call (`<server>__<tool>`) to its downstream. */
  call(prefixedTool: string, args: Record<string, unknown>): Promise<CallToolResult>;
};

export type CompositeTool = {
  /** Bare name; exposed to the host as `qe__<name>`. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Categories that must be present among connected downstreams to expose it. */
  requiresCategories?: string[];
  run(ctx: CompositeContext, args: Record<string, unknown>): Promise<CallToolResult>;
};

/* -------------------------------- helpers -------------------------------- */

function text(s: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: s }], isError };
}

function serverOf(prefixedTool: string): string {
  const i = prefixedTool.indexOf("__");
  return i >= 0 ? prefixedTool.slice(0, i) : "";
}

/** Pull structured data out of a tool result: JSON if the text parses, else the raw text. */
function extractData(result: CallToolResult): unknown {
  const raw = (result.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Loose equality tolerant of DB↔JSON representation drift (1 vs "1", etc.). */
function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== "object" && typeof b !== "object") return String(a) === String(b);
  return false;
}

export type FieldDiff = { path: string; api: unknown; db: unknown; note?: string };

/** Compares the DB value (expected) against the API value (actual). In "subset"
 *  mode only fields present in the DB row are checked; "exact" checks both ways. */
function compare(
  api: unknown,
  db: unknown,
  mode: "subset" | "exact",
  path: string,
  ignore: Set<string>,
  out: FieldDiff[]
): void {
  if (ignore.has(path)) return;
  if (isObject(db) && isObject(api)) {
    const keys = mode === "exact" ? new Set([...Object.keys(api), ...Object.keys(db)]) : new Set(Object.keys(db));
    for (const k of keys) compare(api[k], db[k], mode, path ? `${path}.${k}` : k, ignore, out);
  } else if (Array.isArray(db) && Array.isArray(api)) {
    if (mode === "exact" && db.length !== api.length) {
      out.push({ path: path || "(root)", api: api.length, db: db.length, note: "array length differs" });
    }
    const n = Math.max(db.length, api.length);
    for (let i = 0; i < n; i++) compare(api[i], db[i], mode, `${path}[${i}]`, ignore, out);
  } else if (!looseEqual(api, db)) {
    out.push({ path: path || "(root)", api, db });
  }
}

/* ------------------------------ the tools ------------------------------ */

const SUBCALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tool"],
  properties: {
    tool: { type: "string", description: "A namespaced tool, e.g. openapi__getUser or postgres__query." },
    arguments: { type: "object", description: "Arguments for that tool." },
  },
};

const verifyApiVsDb: CompositeTool = {
  name: "verify_api_vs_db",
  description:
    "End-to-end consistency check: call an API tool and a DB tool, then diff the two payloads and " +
    "report a single verdict. Provide each sub-call as { tool, arguments } using namespaced tool names " +
    "(discover them via tools/list). By default (subset) every field returned by the DB must match the API.",
  requiresCategories: ["database"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["api", "db"],
    properties: {
      api: SUBCALL_SCHEMA,
      db: SUBCALL_SCHEMA,
      match: { type: "string", enum: ["subset", "exact"], description: "Default subset." },
      ignore: { type: "array", items: { type: "string" }, description: "Field paths to ignore (e.g. updated_at)." },
    },
  },
  async run(ctx, args) {
    const api = args.api as { tool: string; arguments?: Record<string, unknown> } | undefined;
    const db = args.db as { tool: string; arguments?: Record<string, unknown> } | undefined;
    const mode = args.match === "exact" ? "exact" : "subset";
    const ignore = new Set(Array.isArray(args.ignore) ? (args.ignore as string[]) : []);
    if (!api?.tool || !db?.tool) return text(`qe__verify_api_vs_db: both "api.tool" and "db.tool" are required.`, true);
    for (const t of [api.tool, db.tool]) {
      if (!ctx.hasServer(serverOf(t))) return text(`qe__verify_api_vs_db: no connected server for "${t}".`, true);
    }

    const [apiRes, dbRes] = await Promise.all([
      ctx.call(api.tool, api.arguments ?? {}),
      ctx.call(db.tool, db.arguments ?? {}),
    ]);
    if (apiRes.isError) return text(`qe__verify_api_vs_db: the API call "${api.tool}" failed:\n${extractData(apiRes)}`, true);
    if (dbRes.isError) return text(`qe__verify_api_vs_db: the DB call "${db.tool}" failed:\n${extractData(dbRes)}`, true);

    const apiData = extractData(apiRes);
    let dbData = extractData(dbRes);
    // A single-row DB result is often wrapped in a 1-element array — unwrap so it
    // compares naturally against a single API object.
    if (Array.isArray(dbData) && dbData.length === 1 && isObject(apiData)) dbData = dbData[0];

    const differences: FieldDiff[] = [];
    compare(apiData, dbData, mode, "", ignore, differences);
    const match = differences.length === 0;

    return text(
      JSON.stringify(
        {
          match,
          mode,
          summary: match
            ? "API and DB agree on every compared field."
            : `${differences.length} field(s) differ between API and DB.`,
          differences,
          api: apiData,
          db: dbData,
        },
        null,
        2
      )
    );
  },
};

export const COMPOSITE_TOOLS: CompositeTool[] = [verifyApiVsDb];
