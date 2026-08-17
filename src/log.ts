/**
 * Structured logging — ALWAYS to stderr. stdout is the MCP transport (JSON-RPC
 * over stdio); a single stray byte there corrupts the protocol, so nothing but
 * the transport may write to it. Hosts (Claude Code, Cursor, …) surface a
 * server's stderr in their MCP logs, which is where per-call routing shows up.
 */
type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...data });
  process.stderr.write(`[qualien-mcp] ${line}\n`);
}

export const log = {
  info: (event: string, data?: Record<string, unknown>) => emit("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => emit("error", event, data),
};
