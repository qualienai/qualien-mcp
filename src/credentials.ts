/**
 * Per-user OAuth credential storage at ~/.qualien-mcp/credentials.json, keyed by
 * server. Holds the dynamic-client registration, tokens, and PKCE verifier for
 * each remote server the user has logged into.
 *
 * NOTE: this is a plain 0600 file, NOT OS-keychain storage — good enough for a
 * developer tool, documented as such. It lives only on the user's machine and is
 * never bundled or transmitted anywhere by qualien-mcp itself.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".qualien-mcp");
const FILE = join(DIR, "credentials.json");

export type ServerCreds = {
  clientInformation?: unknown;
  tokens?: unknown;
  codeVerifier?: string;
};

type Store = Record<string, ServerCreds>;

function read(): Store {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    chmodSync(FILE, 0o600); // enforce even if the file pre-existed with looser perms
  } catch {
    /* best-effort */
  }
}

export function getServerCreds(key: string): ServerCreds {
  return read()[key] ?? {};
}

export function patchServerCreds(key: string, patch: Partial<ServerCreds>): void {
  const store = read();
  store[key] = { ...(store[key] ?? {}), ...patch };
  write(store);
}

export function credentialsPath(): string {
  return FILE;
}
