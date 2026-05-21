import crypto from "node:crypto";

const AUTH_MODE: AuthMode = "password";
const AUTH_TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const AUTH_TOKEN_ISSUER = "codex-web-ui";
const PASSWORD = process.env.CODEX_WEB_UI_PASSWORD || "";
const AUTH_TOKEN_SECRET = process.env.CODEX_WEB_UI_AUTH_SECRET || PASSWORD;
const AUTH_WARNING = !PASSWORD ? "Set CODEX_WEB_UI_PASSWORD before exposing this server." : null;
const AUTH_USER: AuthUser = { id: "password", email: null, name: "Password user", role: "admin" };
const UNAUTHENTICATED_AUTH_STATE = {
  authenticated: false,
  mode: AUTH_MODE,
  warning: AUTH_WARNING,
  user: null,
  tokenExpiresAt: null
};

export type AuthMode = "password";
export type AuthUser = { id: string; email: string | null; name: string | null; role: string };
export type AppSession = { expiresAt: number; mode: AuthMode; user: AuthUser | null };
export type AuthState = {
  authenticated: boolean;
  mode: AuthMode;
  warning: string | null;
  user: AuthUser | null;
  tokenExpiresAt: number | null;
};
type JwtClaims = { iss: string; sub: string; role: string; iat: number; exp: number };

export function isAuthenticated(request: Request): boolean {
  return Boolean(currentSession(request));
}

export function currentSession(request: Request): AppSession | null {
  const token = getBearerToken(request);
  if (!token) {
    return null;
  }
  const claims = verifyAuthToken(token);
  if (!claims) {
    return null;
  }
  return { expiresAt: claims.exp * 1000, mode: AUTH_MODE, user: { ...AUTH_USER, role: claims.role || AUTH_USER.role } };
}

export function authState(request: Request): AuthState {
  const session = currentSession(request);
  return session ? authStateFromSession(session) : UNAUTHENTICATED_AUTH_STATE;
}

export function loginWithPassword(password: unknown): AuthState & { token: string; expiresAt: number } {
  if (!safePasswordEquals(typeof password === "string" ? password : "")) {
    throw httpError(401, "Invalid password");
  }
  const { token, expiresAt } = createAuthToken(AUTH_USER);
  return { token, expiresAt, ...authStateFromSession({ expiresAt, mode: AUTH_MODE, user: AUTH_USER }) };
}

export function authMode(): AuthMode {
  return AUTH_MODE;
}

export function authWarning(): string | null {
  return AUTH_WARNING;
}

function authStateFromSession(session: AppSession): AuthState {
  return {
    authenticated: true,
    mode: session.mode,
    warning: AUTH_WARNING,
    user: session.user,
    tokenExpiresAt: session.expiresAt
  };
}

function getBearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || "";
}

function createAuthToken(user: AuthUser): { token: string; expiresAt: number } {
  if (!AUTH_TOKEN_SECRET) {
    throw httpError(500, "CODEX_WEB_UI_PASSWORD is required before login is available.");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = nowSeconds + Math.floor(AUTH_TOKEN_TTL_MS / 1000);
  const claims: JwtClaims = {
    iss: AUTH_TOKEN_ISSUER,
    sub: user.id,
    role: user.role,
    iat: nowSeconds,
    exp: expiresAtSeconds
  };
  return {
    token: signJwt(claims),
    expiresAt: expiresAtSeconds * 1000
  };
}

function signJwt(claims: JwtClaims): string {
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlJson(claims);
  const signature = hmacBase64Url(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

function verifyAuthToken(token: string): JwtClaims | null {
  if (!AUTH_TOKEN_SECRET) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  if (!timingSafeStringEquals(signature, hmacBase64Url(`${header}.${payload}`))) {
    return null;
  }
  const parsedHeader = parseJwtPart(header);
  const claims = parseJwtPart(payload);
  if (parsedHeader.alg !== "HS256" || parsedHeader.typ !== "JWT") {
    return null;
  }
  const exp = numberValue(claims.exp);
  if (claims.iss !== AUTH_TOKEN_ISSUER || claims.sub !== AUTH_USER.id || !exp || Date.now() >= exp * 1000) {
    return null;
  }
  return {
    iss: AUTH_TOKEN_ISSUER,
    sub: AUTH_USER.id,
    role: typeof claims.role === "string" ? claims.role : AUTH_USER.role,
    iat: numberValue(claims.iat) ?? 0,
    exp
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseJwtPart(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function hmacBase64Url(value: string): string {
  return crypto.createHmac("sha256", AUTH_TOKEN_SECRET).update(value).digest("base64url");
}

function timingSafeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function safePasswordEquals(value: string): boolean {
  if (!PASSWORD) {
    return false;
  }
  return timingSafeStringEquals(value, PASSWORD);
}

function numberValue(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
