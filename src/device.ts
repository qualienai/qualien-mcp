/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for PUBLIC clients.
 *
 * Why this exists: GitHub requires a client_secret to exchange an authorization
 * code ("Client secrets are required to generate access tokens for your app,
 * unless your app uses the device flow"), and PKCE does not lift that — GitHub
 * does not distinguish public from confidential clients. Since qualien-mcp ships
 * on npm, a secret in the tarball is a published secret. The device flow is the
 * one grant GitHub sanctions without a secret, and it is explicitly intended for
 * "constrained environments (CLIs, IoT devices, or headless systems)".
 *
 * So: qualien-mcp ships only a public client_id. Each user runs
 * `qualien-mcp login github`, approves a short code on github.com, and their own
 * tokens land in ~/.qualien-mcp/credentials.json (0600) on their own machine.
 *
 * This lives OUTSIDE the SDK's OAuthClientProvider, which models the
 * authorization-code flow only; device-flow servers get a bearer header instead.
 */
import { getServerCreds, patchServerCreds } from "./credentials.js";
import { log } from "./log.js";

/** Endpoints for the two device-flow calls (RFC 8628 §3.1 and §3.4). */
export type DeviceFlowEndpoints = {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
};

/** What we persist. Superset of the token response, plus absolute expiry. */
export type DeviceTokens = {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  scope?: string;
  /** Epoch ms. Absent when the token does not expire (GitHub's default). */
  expires_at?: number;
};

export class NeedsDeviceLoginError extends Error {
  constructor(public serverKey: string) {
    super(`"${serverKey}" needs authorization — run: npx qualien-mcp login ${serverKey}`);
    this.name = "NeedsDeviceLoginError";
  }
}

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

type TokenResponse = {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function postForm(url: string, body: Record<string, string>): Promise<TokenResponse & DeviceCodeResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      // Without this GitHub answers in form-encoding, not JSON.
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  return parsed as TokenResponse & DeviceCodeResponse;
}

function toStored(t: TokenResponse): DeviceTokens {
  if (!t.access_token) throw new Error("token response had no access_token");
  return {
    access_token: t.access_token,
    token_type: t.token_type ?? "bearer",
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
    // GitHub OAuth App tokens don't expire unless the app opts into expiring
    // tokens, in which case expires_in comes back and we track it.
    ...(t.expires_in ? { expires_at: Date.now() + t.expires_in * 1000 } : {}),
  };
}

/**
 * Runs the full interactive device flow: ask for a code, show the user where to
 * enter it, then poll until they approve. Honours the server's polling interval
 * and `slow_down` — polling faster than told earns rate limiting.
 */
export async function deviceLogin(
  serverKey: string,
  endpoints: DeviceFlowEndpoints,
  clientId: string,
  scope: string | undefined,
  write: (s: string) => void
): Promise<DeviceTokens> {
  const start = await postForm(endpoints.deviceAuthorizationUrl, {
    client_id: clientId,
    ...(scope ? { scope } : {}),
  });
  if (start.error || !start.device_code) {
    throw new Error(
      `device authorization failed: ${start.error ?? "no device_code"}` +
        (start.error_description ? ` — ${start.error_description}` : "")
    );
  }

  write(
    `\nqualien-mcp: authorize "${serverKey}"\n\n` +
      `  1. open  ${start.verification_uri}\n` +
      `  2. enter code  ${start.user_code}\n\n` +
      `Waiting for approval (the code expires in ${Math.round(start.expires_in / 60)} min)…\n`
  );
  log.info("device_flow_started", { server: serverKey, verification_uri: start.verification_uri });

  let intervalMs = (start.interval ?? 5) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await postForm(endpoints.tokenUrl, {
      client_id: clientId,
      device_code: start.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    if (res.access_token) {
      const tokens = toStored(res);
      patchServerCreds(serverKey, { tokens });
      log.info("device_flow_authorized", { server: serverKey });
      return tokens;
    }
    switch (res.error) {
      case "authorization_pending":
        break; // the user hasn't finished yet — keep waiting
      case "slow_down":
        // RFC 8628 §3.5: back off by 5s on top of the current interval.
        intervalMs += 5000;
        break;
      case "access_denied":
        throw new Error(`authorization denied — you declined the request for "${serverKey}".`);
      case "expired_token":
        throw new Error(`the code expired before it was approved — run login again.`);
      default:
        throw new Error(
          `device token exchange failed: ${res.error ?? "unknown error"}` +
            (res.error_description ? ` — ${res.error_description}` : "")
        );
    }
  }
  throw new Error(`timed out waiting for approval of "${serverKey}" — run login again.`);
}

/** Exchanges a refresh token for a fresh access token (only relevant when the
 *  OAuth app has expiring tokens enabled). */
async function refresh(
  serverKey: string,
  endpoints: DeviceFlowEndpoints,
  clientId: string,
  refreshToken: string
): Promise<DeviceTokens> {
  const res = await postForm(endpoints.tokenUrl, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!res.access_token) throw new NeedsDeviceLoginError(serverKey);
  const tokens = toStored(res);
  patchServerCreds(serverKey, { tokens });
  log.info("device_token_refreshed", { server: serverKey });
  return tokens;
}

/**
 * Returns a usable access token for a device-flow server, refreshing if it has
 * expired. Throws NeedsDeviceLoginError when the user has never logged in (or
 * can't be refreshed) so the gateway can skip that server with a hint instead of
 * failing startup.
 */
export async function getDeviceAccessToken(
  serverKey: string,
  endpoints: DeviceFlowEndpoints,
  clientId: string
): Promise<string> {
  const tokens = getServerCreds(serverKey).tokens as DeviceTokens | undefined;
  if (!tokens?.access_token) throw new NeedsDeviceLoginError(serverKey);

  // 60s of slack so we don't hand out a token that dies mid-request.
  const expired = typeof tokens.expires_at === "number" && tokens.expires_at - 60_000 < Date.now();
  if (!expired) return tokens.access_token;
  if (!tokens.refresh_token) throw new NeedsDeviceLoginError(serverKey);
  const fresh = await refresh(serverKey, endpoints, clientId, tokens.refresh_token);
  return fresh.access_token;
}
