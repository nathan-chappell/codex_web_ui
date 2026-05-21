const CORS_ALLOWED_HEADERS = "Authorization, Content-Type, X-File-Name";
const CORS_ALLOWED_METHODS = "GET, HEAD, POST, DELETE, OPTIONS";
const CORS_MAX_AGE_SECONDS = "600";

export function corsHeaders(request: Request): { allowed: boolean; headers: Headers } {
  const headers = new Headers();
  const origin = request.headers.get("origin")?.trim() || "";
  if (!origin) {
    return { allowed: true, headers };
  }
  if (!isAllowedOrigin(request, origin)) {
    return { allowed: false, headers };
  }
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  headers.set("Access-Control-Max-Age", CORS_MAX_AGE_SECONDS);
  headers.set("Vary", "Origin");
  return { allowed: true, headers };
}

function isAllowedOrigin(request: Request, origin: string): boolean {
  if (isSameOrigin(request, origin)) {
    return true;
  }
  return parseCsvEnv(process.env.CODEX_WEB_UI_ALLOWED_ORIGINS).some((pattern) => originMatchesPattern(origin, pattern));
}

function isSameOrigin(request: Request, origin: string): boolean {
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    const protocol = request.headers.get("x-forwarded-proto") || requestUrl.protocol.replace(":", "");
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || requestUrl.host;
    return originUrl.protocol === `${protocol}:` && originUrl.host === host;
  } catch {
    return false;
  }
}

function originMatchesPattern(origin: string, pattern: string): boolean {
  try {
    const originUrl = new URL(origin);
    const match = /^(https?):\/\/([^/:]+|\*)(?::(\*|\d+))?$/.exec(pattern.trim());
    if (!match) {
      return origin === pattern;
    }
    const [, protocol, hostname, port] = match;
    if (originUrl.protocol !== `${protocol}:`) {
      return false;
    }
    if (hostname !== "*" && hostname.toLowerCase() !== originUrl.hostname.toLowerCase()) {
      return false;
    }
    return port === "*" || (port ? port === originUrl.port : !originUrl.port);
  } catch {
    return origin === pattern;
  }
}

function parseCsvEnv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
