const DEFAULT_CALLBACK_PORT = 33420;
const CALLBACK_BASE_PATH = "/api/mcp/oauth/callback";
const CALLBACK_TTL_MS = 10 * 60 * 1000;

type RegisteredMcpCallback = {
  serverName: string;
  path: string;
  state: string;
  localUrl: string;
  expiresAt: number;
};

const callbacks = new Map<string, RegisteredMcpCallback>();

export function mcpOAuthCallbackPort(): number {
  const raw = process.env.CODEX_WEB_UI_MCP_OAUTH_CALLBACK_PORT || process.env.MCP_OAUTH_CALLBACK_PORT || String(DEFAULT_CALLBACK_PORT);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return DEFAULT_CALLBACK_PORT;
  }
  return value;
}

export function mcpOAuthCallbackBaseUrl(request: Request): string {
  return `${publicOrigin(request)}${CALLBACK_BASE_PATH}`;
}

export function registerMcpOAuthCallback(serverName: string, authorizationUrl: string): void {
  purgeExpiredCallbacks();

  const url = new URL(authorizationUrl);
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  if (!redirectUri || !state) {
    throw new Error("Codex MCP OAuth authorization URL is missing redirect_uri or state");
  }

  const redirectUrl = new URL(redirectUri);
  if (!redirectUrl.pathname.startsWith(`${CALLBACK_BASE_PATH}/`)) {
    throw new Error("Codex MCP OAuth callback URL was not configured for the Web UI relay");
  }

  const port = mcpOAuthCallbackPort();
  callbacks.set(callbackKey(redirectUrl.pathname, state), {
    serverName,
    path: redirectUrl.pathname,
    state,
    localUrl: `http://127.0.0.1:${port}${redirectUrl.pathname}`,
    expiresAt: Date.now() + CALLBACK_TTL_MS
  });
}

export function isMcpOAuthCallbackPath(pathname: string): boolean {
  return pathname === CALLBACK_BASE_PATH || pathname.startsWith(`${CALLBACK_BASE_PATH}/`);
}

export async function relayMcpOAuthCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!isMcpOAuthCallbackPath(url.pathname)) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404, headers: noStoreHeaders() });
  }
  if (request.method !== "GET") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405, headers: noStoreHeaders() });
  }

  purgeExpiredCallbacks();

  const state = url.searchParams.get("state") || "";
  const key = callbackKey(url.pathname, state);
  const registered = callbacks.get(key);
  callbacks.delete(key);

  if (!registered) {
    return oauthCallbackHtml("MCP OAuth callback expired or was already used.", 403);
  }
  if (registered.expiresAt < Date.now()) {
    return oauthCallbackHtml("MCP OAuth callback expired.", 403);
  }

  const localUrl = new URL(registered.localUrl);
  localUrl.search = url.search;

  let response: Response;
  try {
    response = await fetch(localUrl, {
      method: "GET",
      redirect: "manual",
      cache: "no-store"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return oauthCallbackHtml(`Could not reach local Codex OAuth listener for ${registered.serverName}: ${escapeHtml(message)}`, 502);
  }

  const headers = noStoreHeaders();
  const contentType = response.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  const location = response.headers.get("location");
  if (location) {
    headers.set("Location", location);
  }
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function publicOrigin(request: Request): string {
  const configured = process.env.CODEX_WEB_UI_PUBLIC_ORIGIN?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const requestUrl = new URL(request.url);
  const protocol = request.headers.get("x-forwarded-proto") || requestUrl.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || requestUrl.host;
  return `${protocol}://${host}`;
}

function callbackKey(pathname: string, state: string): string {
  return `${pathname}\n${state}`;
}

function purgeExpiredCallbacks(): void {
  const now = Date.now();
  for (const [key, callback] of callbacks) {
    if (callback.expiresAt < now) {
      callbacks.delete(key);
    }
  }
}

function oauthCallbackHtml(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>MCP OAuth</title><body style="font-family: system-ui, sans-serif; padding: 2rem;"><h1>MCP OAuth</h1><p>${message}</p></body>`,
    {
      status,
      headers: {
        ...Object.fromEntries(noStoreHeaders()),
        "Content-Type": "text/html; charset=utf-8"
      }
    }
  );
}

function noStoreHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store"
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
