import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { CodexBridge } from "./codexBridge.js";
import { EventHub } from "./eventHub.js";
import { SessionLogStore } from "./logStore.js";
import type { JsonValue } from "./types.js";

const projectRoot = process.cwd();
const staticDir = path.join(projectRoot, "dist/public");
const homeDir = os.homedir();

loadEnvFile(path.join(projectRoot, ".env"));

const PORT = Number(process.env.PORT || 4545);
const HOST = process.env.HOST || "127.0.0.1";
const PASSWORD = process.env.CODEX_WEB_UI_PASSWORD || "";
const SESSION_COOKIE = "codex_web_ui_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || "";
const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || process.env.VITE_CLERK_PUBLISHABLE_KEY || "";
const CLERK_JWT_KEY = process.env.CLERK_JWT_KEY || "";
const CLERK_AUTHORIZED_PARTIES = parseCsvEnv(process.env.CLERK_AUTHORIZED_PARTIES);
const AUTH_MODE: AuthMode = CLERK_SECRET_KEY && CLERK_PUBLISHABLE_KEY ? "clerk" : PASSWORD ? "password" : "open";
const clerkClient = AUTH_MODE === "clerk"
  ? createClerkClient({ secretKey: CLERK_SECRET_KEY, publishableKey: CLERK_PUBLISHABLE_KEY })
  : null;

const logs = new SessionLogStore(process.env.CODEX_WEB_UI_DATA_DIR || path.join(projectRoot, "data"));
const hub = new EventHub();
const bridge = new CodexBridge(
  {
    command: process.env.CODEX_COMMAND || "codex",
    cwd: process.env.CODEX_CWD || projectRoot,
    model: process.env.CODEX_MODEL || "gpt-5.5",
    reasoningEffort: process.env.CODEX_REASONING_EFFORT || "high",
    fastMode: process.env.CODEX_FAST_MODE !== "0"
  },
  hub,
  logs
);

type AuthMode = "open" | "password" | "clerk";
type AuthUser = { id: string; email: string | null; name: string | null; role: string };
type AppSession = { createdAt: number; mode: AuthMode; user: AuthUser | null };

const sessions = new Map<string, AppSession>();

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

await logs.ensure();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const startedAt = Date.now();
    if (shouldLogHttpRequest(url.pathname)) {
      res.once("finish", () => {
        void logs.append({
          type: "server",
          method: "http/request",
          payload: {
            method: req.method || "",
            path: url.pathname,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt
          }
        });
      });
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      if (AUTH_MODE !== "password") {
        return sendJson(res, 400, { ok: false, error: "Password login is not enabled" });
      }
      const body = await readJsonBody(req);
      if (!safePasswordEquals(typeof body.password === "string" ? body.password : "")) {
        return sendJson(res, 401, { ok: false, error: "Invalid password" });
      }
      const token = crypto.randomBytes(32).toString("base64url");
      sessions.set(token, { createdAt: Date.now(), mode: "password", user: null });
      res.setHeader("Set-Cookie", makeCookie(token));
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/clerk/session" && req.method === "POST") {
      if (AUTH_MODE !== "clerk") {
        return sendJson(res, 400, { ok: false, error: "Clerk login is not enabled" });
      }
      const body = await readJsonBody(req);
      const clerkUser = await authenticateClerkToken(typeof body.token === "string" ? body.token : "");
      const token = crypto.randomBytes(32).toString("base64url");
      sessions.set(token, { createdAt: Date.now(), mode: "clerk", user: clerkUser });
      res.setHeader("Set-Cookie", makeCookie(token));
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      const token = getSessionToken(req);
      if (token) {
        sessions.delete(token);
      }
      res.setHeader("Set-Cookie", clearCookie());
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/auth" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, ...authState(req) });
    }

    if (url.pathname.startsWith("/api/") && !isAuthenticated(req)) {
      return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, status: bridge.summary() });
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      hub.add(req, res);
      bridge.start().catch((error: Error) => {
        hub.broadcast("server-status", bridge.summary());
        hub.broadcast("stderr", { at: Date.now(), line: error.message });
      });
      return;
    }

    if (url.pathname === "/api/rpc" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.method !== "string") {
        return sendJson(res, 400, { ok: false, error: "Missing JSON-RPC method" });
      }
      const result = await bridge.request(body.method, (body.params ?? {}) as JsonValue);
      return sendJson(res, 200, { ok: true, result });
    }

    if (url.pathname === "/api/server/restart" && req.method === "POST") {
      await bridge.restart();
      return sendJson(res, 200, { ok: true, status: bridge.summary() });
    }

    if (url.pathname === "/api/server/stop" && req.method === "POST") {
      await bridge.stop();
      return sendJson(res, 200, { ok: true, status: bridge.summary() });
    }

    if (url.pathname === "/api/repositories/browse" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, browser: await browseRepositories(url.searchParams.get("path")) });
    }

    if (url.pathname === "/api/repositories/create" && req.method === "POST") {
      const body = await readJsonBody(req);
      const browser = await createRepository(body.parentPath, body.name);
      return sendJson(res, 200, { ok: true, browser });
    }

    if (url.pathname.startsWith("/api/logs/") && req.method === "DELETE") {
      const threadId = decodeURIComponent(url.pathname.slice("/api/logs/".length));
      return sendJson(res, 200, { ok: true, threadId, deleted: await logs.deleteThreadLog(threadId) });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    return serveStatic(url.pathname, res, req.method === "HEAD");
  } catch (error) {
    const err = error as Error & { data?: unknown; statusCode?: number };
    return sendJson(res, err.statusCode || 500, { ok: false, error: err.message || "Internal server error", data: err.data });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`codex-web-ui listening on http://${HOST}:${PORT}`);
  console.log(`auth mode: ${AUTH_MODE}${AUTH_MODE === "open" ? " (no password or Clerk configured)" : ""}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseCsvEnv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function shutdown(): Promise<void> {
  await bridge.stop();
  process.exit(0);
}

function isAuthenticated(req: IncomingMessage): boolean {
  if (AUTH_MODE === "open") {
    return true;
  }
  return Boolean(currentSession(req));
}

function currentSession(req: IncomingMessage): AppSession | null {
  const token = getSessionToken(req);
  if (!token) {
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  if (session.mode !== AUTH_MODE) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function authState(req: IncomingMessage): { authenticated: boolean; mode: AuthMode; warning: string | null; user: AuthUser | null } {
  if (AUTH_MODE === "open") {
    return {
      authenticated: true,
      mode: "open",
      warning: "No auth configured: anyone who can reach this server has full access.",
      user: null
    };
  }
  const session = currentSession(req);
  return {
    authenticated: Boolean(session),
    mode: AUTH_MODE,
    warning: null,
    user: session?.user ?? null
  };
}

function getSessionToken(req: IncomingMessage): string {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[SESSION_COOKIE] || "";
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey) {
      cookies[rawKey] = decodeURIComponent(rawValue.join("="));
    }
  }
  return cookies;
}

function makeCookie(token: string): string {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

function clearCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function shouldLogHttpRequest(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function safePasswordEquals(value: string): boolean {
  if (!PASSWORD) {
    return false;
  }
  const provided = Buffer.from(value);
  const expected = Buffer.from(PASSWORD);
  if (provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(provided, expected);
}

async function authenticateClerkToken(token: string): Promise<AuthUser> {
  if (!token || !clerkClient) {
    throw httpError(401, "Missing Clerk bearer token.");
  }
  const payload = await verifyToken(token, {
    secretKey: CLERK_SECRET_KEY,
    jwtKey: CLERK_JWT_KEY || undefined,
    authorizedParties: CLERK_AUTHORIZED_PARTIES.length ? CLERK_AUTHORIZED_PARTIES : undefined
  }).catch(() => {
    throw httpError(401, "Invalid Clerk session.");
  });
  const clerkUserId = String(payload.sub || "").trim();
  if (!clerkUserId) {
    throw httpError(401, "Clerk session did not include a user id.");
  }

  const user = await clerkClient.users.getUser(clerkUserId);
  const publicMetadata = asRecord(user.publicMetadata);
  if (publicMetadata.active !== true) {
    throw httpError(403, "This Clerk account is not active for the app.");
  }
  const role = publicMetadata.role === "admin" ? "admin" : "user";
  const email = primaryEmailForClerkUser(user);
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || email;
  return { id: user.id, email, name: name || null, role };
}

function primaryEmailForClerkUser(user: { primaryEmailAddressId: string | null; emailAddresses: { id: string; emailAddress: string }[] }): string | null {
  const primary = user.emailAddresses.find((item) => item.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
  return primary?.emailAddress?.trim().toLowerCase() || null;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

async function browseRepositories(inputPath: unknown): Promise<Record<string, unknown>> {
  const currentPath = resolveExplorerPath(inputPath);
  const stats = statSync(currentPath);
  if (!stats.isDirectory()) {
    throw new Error("Path is not a directory");
  }
  const entries = await readdir(currentPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => {
      const entryPath = path.join(currentPath, entry.name);
      let isDirectory = entry.isDirectory();
      try {
        isDirectory = statSync(entryPath).isDirectory();
      } catch {
        isDirectory = false;
      }
      return isDirectory
        ? {
            name: entry.name,
            path: entryPath,
            displayPath: displayPath(entryPath),
            isGitRepo: isGitRepo(entryPath),
            hidden: entry.name.startsWith(".")
          }
        : null;
    })
    .filter((entry): entry is { name: string; path: string; displayPath: string; isGitRepo: boolean; hidden: boolean } => Boolean(entry))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || Number(b.isGitRepo) - Number(a.isGitRepo) || a.name.localeCompare(b.name));

  return {
    path: currentPath,
    displayPath: displayPath(currentPath),
    parentPath: path.dirname(currentPath) === currentPath ? null : path.dirname(currentPath),
    homePath: homeDir,
    isGitRepo: isGitRepo(currentPath),
    entries: directories
  };
}

async function createRepository(parentPath: unknown, name: unknown): Promise<Record<string, unknown>> {
  const parent = resolveExplorerPath(parentPath);
  if (!statSync(parent).isDirectory()) {
    throw new Error("Parent path is not a directory");
  }
  const repoName = typeof name === "string" ? name.trim() : "";
  if (!repoName || repoName === "." || repoName === ".." || repoName.includes("/") || repoName.includes("\\")) {
    throw new Error("Enter a single folder name for the new repository");
  }
  const repoPath = path.join(parent, repoName);
  if (existsSync(repoPath)) {
    throw new Error("A folder already exists with that name");
  }
  await mkdir(repoPath, { recursive: false });
  await runGitInit(repoPath);
  return browseRepositories(repoPath);
}

function resolveExplorerPath(inputPath: unknown): string {
  const value = typeof inputPath === "string" && inputPath.trim() ? inputPath.trim() : homeDir;
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return path.resolve(homeDir, value.slice(2));
  }
  return path.resolve(path.isAbsolute(value) ? value : path.join(homeDir, value));
}

function displayPath(filePath: string): string {
  const relative = path.relative(homeDir, filePath);
  if (!relative) {
    return "~";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/${relative}`;
  }
  return filePath;
}

function isGitRepo(dirPath: string): boolean {
  return existsSync(path.join(dirPath, ".git"));
}

async function runGitInit(repoPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["init", "--", repoPath], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(requestPath: string, res: ServerResponse, headOnly: boolean): void {
  const cleanPath = decodeURIComponent(requestPath.split("?")[0] || "/");
  const relative = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const absolute = path.normalize(path.join(staticDir, relative));
  const indexPath = path.join(staticDir, "index.html");

  if (!absolute.startsWith(staticDir)) {
    return sendJson(res, 403, { ok: false, error: "Forbidden" });
  }

  const filePath = existsSync(absolute) && statSync(absolute).isFile() ? absolute : indexPath;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendJson(res, 404, { ok: false, error: "Frontend build not found. Run npm run build first." });
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300"
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}
