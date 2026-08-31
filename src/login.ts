/**
 * `qualien-mcp login <server>` — runs the interactive OAuth authorization-code
 * flow for a remote server ONCE, and saves the resulting tokens to
 * ~/.qualien-mcp/credentials.json. After this, the gateway connects to that
 * server non-interactively (loading + refreshing the saved tokens).
 *
 * Each user runs this with their OWN account; nothing is shared or bundled.
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider } from "./oauth.js";
import { deviceLogin, type DeviceTokens } from "./device.js";
import { isHttp, type Config, type HttpServerConfig } from "./config.js";
import { credentialsPath, getServerCreds } from "./credentials.js";

// Fixed loopback port so the dynamically-registered redirect_uri is stable across
// re-logins. Override with QUALIEN_MCP_CALLBACK_PORT if it clashes with something.
const CALLBACK_PORT = Number(process.env.QUALIEN_MCP_CALLBACK_PORT ?? 41999);

export async function runLogin(serverKey: string, config: Config, version: string): Promise<void> {
  const cfg = config.servers[serverKey];
  if (!cfg) {
    throw new Error(`Unknown server "${serverKey}". Add it to your qualien-mcp.config.json first.`);
  }
  if (!isHttp(cfg)) {
    throw new Error(`"${serverKey}" is a local (stdio) server — login is only for remote OAuth servers.`);
  }

  // Public clients (GitHub) use the device flow: no secret, no loopback redirect.
  if (cfg.deviceFlow) return runDeviceLogin(serverKey, cfg, version);

  // Loopback listener that catches the OAuth redirect and hands back the code.
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
    if (u.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    const code = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<html><body style="font-family:system-ui;padding:2rem">` +
        `<h2>${err ? `Authorization failed: ${err}` : "Authorized ✓"}</h2>` +
        `<p>You can close this tab and return to your terminal.</p></body></html>`
    );
    if (code) resolveCode(code);
    else if (err) rejectCode(new Error(`authorization failed: ${err}`));
  });
  await new Promise<void>((res, rej) => {
    server.on("error", rej);
    server.listen(CALLBACK_PORT, "127.0.0.1", res);
  });

  const authProvider = new FileOAuthProvider(serverKey, CALLBACK_PORT, {
    interactive: true,
    scope: cfg.scope,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  const url = new URL(cfg.url);

  const connect = async () => {
    const transport = new StreamableHTTPClientTransport(url, { authProvider });
    const client = new Client({ name: `qualien-mcp:${serverKey}`, version }, { capabilities: {} });
    await client.connect(transport);
    return client;
  };

  try {
    // Already have valid tokens? Then connect succeeds and there's nothing to do.
    const client = await connect();
    const { tools } = await client.listTools();
    process.stderr.write(`\nqualien-mcp: "${serverKey}" already authorized ✓ — ${tools.length} tools.\n`);
    await client.close();
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    // The provider opened the browser; wait for the redirect to deliver the code,
    // finish the token exchange, then reconnect with the saved tokens.
    const code = await codePromise;
    const finishTransport = new StreamableHTTPClientTransport(url, { authProvider });
    await finishTransport.finishAuth(code);
    const client = await connect();
    const { tools } = await client.listTools();
    process.stderr.write(
      `\nqualien-mcp: authorized "${serverKey}" ✓ — ${tools.length} tools now available.\n` +
        `Tokens saved to ${credentialsPath()}\n`
    );
    await client.close();
  } finally {
    server.close();
  }
}

/** Connects to a device-flow remote using a bearer token. */
async function connectWithToken(
  serverKey: string,
  cfg: HttpServerConfig,
  accessToken: string,
  version: string
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers: { ...(cfg.headers ?? {}), authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: `qualien-mcp:${serverKey}`, version }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/**
 * Device Authorization Grant login (RFC 8628): show the user a short code, wait
 * for them to approve it on the provider's site, then prove the token actually
 * works against the MCP endpoint before declaring success.
 */
async function runDeviceLogin(serverKey: string, cfg: HttpServerConfig, version: string): Promise<void> {
  if (!cfg.clientId) {
    throw new Error(`"${serverKey}" uses the device flow but has no clientId — set one in your config.`);
  }

  // Already logged in? Prove it and stop, rather than making them approve again.
  const saved = getServerCreds(serverKey).tokens as DeviceTokens | undefined;
  if (saved?.access_token) {
    try {
      const client = await connectWithToken(serverKey, cfg, saved.access_token, version);
      const { tools } = await client.listTools();
      process.stderr.write(`\nqualien-mcp: "${serverKey}" already authorized ✓ — ${tools.length} tools.\n`);
      await client.close();
      return;
    } catch {
      process.stderr.write(`qualien-mcp: saved "${serverKey}" token no longer works — re-authorizing.\n`);
    }
  }

  const tokens = await deviceLogin(serverKey, cfg.deviceFlow!, cfg.clientId, cfg.scope, (s) =>
    process.stderr.write(s)
  );
  const client = await connectWithToken(serverKey, cfg, tokens.access_token, version);
  const { tools } = await client.listTools();
  process.stderr.write(
    `\nqualien-mcp: authorized "${serverKey}" ✓ — ${tools.length} tools now available.\n` +
      `Tokens saved to ${credentialsPath()}\n`
  );
  await client.close();
}
