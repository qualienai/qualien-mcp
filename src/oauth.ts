/**
 * An OAuthClientProvider (the SDK's client-side OAuth contract) backed by the
 * per-user credentials file. The SDK's StreamableHTTPClientTransport drives the
 * whole authorization-code + PKCE + dynamic-registration + refresh dance through
 * this provider; we just persist the pieces and (in interactive mode) open the
 * browser.
 *
 * Two modes:
 *  - interactive (the `login` command): open the browser to the authorize URL.
 *  - non-interactive (the gateway): if a redirect is ever required, throw
 *    NeedsLoginError so the gateway can skip that server and tell the user to run
 *    `qualien-mcp login <server>` — the gateway must never try to pop a browser
 *    mid-session.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { getServerCreds, patchServerCreds } from "./credentials.js";
import { log } from "./log.js";

export class NeedsLoginError extends Error {
  constructor(public serverKey: string) {
    super(`"${serverKey}" needs authorization — run: npx qualien-mcp login ${serverKey}`);
    this.name = "NeedsLoginError";
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is also printed to stderr, so the user can open it by hand */
  }
}

export class FileOAuthProvider implements OAuthClientProvider {
  constructor(
    private serverKey: string,
    private redirectPort: number,
    private opts: { interactive: boolean; scope?: string; clientId?: string; clientSecret?: string }
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.redirectPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "qualien-mcp",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  state(): string {
    return randomUUID();
  }

  clientInformation(): OAuthClientInformation | undefined {
    // Prefer a client saved from a prior dynamic registration; otherwise fall back
    // to a pre-registered client id from config (required for non-DCR servers like
    // GitHub). Returning a client here makes the SDK skip DCR entirely.
    const saved = getServerCreds(this.serverKey).clientInformation as OAuthClientInformation | undefined;
    if (saved) return saved;
    if (this.opts.clientId) {
      return {
        client_id: this.opts.clientId,
        ...(this.opts.clientSecret ? { client_secret: this.opts.clientSecret } : {}),
      };
    }
    return undefined;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    patchServerCreds(this.serverKey, { clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return getServerCreds(this.serverKey).tokens as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    patchServerCreds(this.serverKey, { tokens });
  }

  saveCodeVerifier(verifier: string): void {
    patchServerCreds(this.serverKey, { codeVerifier: verifier });
  }

  codeVerifier(): string {
    const v = getServerCreds(this.serverKey).codeVerifier;
    if (!v) throw new Error("no PKCE code_verifier saved — start the login flow again");
    return v;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.opts.interactive) throw new NeedsLoginError(this.serverKey);
    log.info("oauth_open_browser", { server: this.serverKey });
    process.stderr.write(
      `\nqualien-mcp: authorize "${this.serverKey}" in your browser (opening now):\n  ${authorizationUrl.toString()}\n\n`
    );
    openBrowser(authorizationUrl.toString());
  }
}
