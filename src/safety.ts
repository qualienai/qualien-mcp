/**
 * Safe-by-default guardrails, enforced CENTRALLY in the gateway before a tool
 * call is forwarded to its downstream — so they hold no matter what the
 * downstream server itself permits.
 *
 *   - filesystem `roots`: reject calls whose path args escape the allowed roots.
 *   - database `readOnly` (default true): reject write SQL.
 *   - infra `allowDestructive` (default false): reject destructive-named tools.
 *
 * HONEST SCOPE: these prevent an LLM from *accidentally* doing damage. The SQL
 * check is keyword-based (heuristic), not a parser — a determined actor can evade
 * it. This is not adversarial sandboxing; real isolation needs the downstream's
 * own permission model or a container.
 */
import { isAbsolute, resolve } from "node:path";
import type { ServerConfig } from "./config.js";

export type Block = { reason: string };

// Write / DDL / privilege statements. Matched after stripping comments.
const WRITE_SQL =
  /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|merge|upsert|copy)\b/i;
const SQL_ARG_KEYS = ["sql", "query", "statement", "command"];

// Destructive verbs in a tool name (docker/k8s), e.g. delete_pod, remove_container, prune.
const DESTRUCTIVE_TOOL = /(^|[_-])(delete|destroy|remove|prune|kill|drop|purge|rm|terminate)([_-]|$)/i;

// Argument keys that carry filesystem paths (server-filesystem's tools).
const PATH_ARG_KEYS = ["path", "paths", "source", "destination", "src", "dest", "directory", "dir"];

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

function collectStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Is `p` inside one of the allowed roots? Roots + path are resolved against cwd. */
function withinRoots(p: string, roots: string[]): boolean {
  const abs = isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
  return roots.some((root) => {
    const base = resolve(root);
    return abs === base || abs.startsWith(base + "/");
  });
}

/**
 * Returns a Block (with a user-facing reason) if the call should be refused, or
 * null to allow it. `args` is the tool's raw arguments object.
 */
export function checkCall(
  cfg: ServerConfig,
  toolName: string,
  args: Record<string, unknown> | undefined
): Block | null {
  const a = args ?? {};

  // Database: read-only unless explicitly opted out.
  if (cfg.category === "database" && cfg.readOnly !== false) {
    for (const key of SQL_ARG_KEYS) {
      const v = a[key];
      if (typeof v === "string" && WRITE_SQL.test(stripSqlComments(v))) {
        return {
          reason:
            `blocked: "${toolName}" contains a write/DDL statement and this database server is ` +
            `read-only. Set "readOnly": false for this server to allow writes.`,
        };
      }
    }
  }

  // Filesystem: keep path arguments inside the configured roots.
  if (cfg.roots && cfg.roots.length > 0) {
    for (const key of PATH_ARG_KEYS) {
      for (const p of collectStrings(a[key])) {
        if (!withinRoots(p, cfg.roots)) {
          return {
            reason: `blocked: path "${p}" is outside the allowed roots (${cfg.roots.join(", ")}).`,
          };
        }
      }
    }
  }

  // Infra: block destructive-named tools unless explicitly permitted.
  if (cfg.category === "infra" && cfg.allowDestructive !== true && DESTRUCTIVE_TOOL.test(toolName)) {
    return {
      reason:
        `blocked: "${toolName}" looks destructive and this server disallows it by default. ` +
        `Set "allowDestructive": true for this server to permit it.`,
    };
  }

  return null;
}
