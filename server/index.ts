import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
const AUTH_MODE: AuthMode = CLERK_SECRET_KEY && CLERK_PUBLISHABLE_KEY ? "clerk" : "password";
const AUTH_WARNING = AUTH_MODE === "password" && !PASSWORD
  ? "Set CODEX_WEB_UI_PASSWORD or Clerk credentials before exposing this server."
  : null;
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
    fastMode: process.env.CODEX_FAST_MODE !== "0",
    appServerSocketPath: process.env.CODEX_APP_SERVER_SOCKET || ""
  },
  hub,
  logs
);

type AuthMode = "password" | "clerk";
type AuthUser = { id: string; email: string | null; name: string | null; role: string };
type AppSession = { createdAt: number; mode: AuthMode; user: AuthUser | null };

const sessions = new Map<string, AppSession>();

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".ogg": "video/ogg",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".3gp": "video/3gpp"
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

    if (url.pathname === "/api/uploads" && req.method === "POST") {
      return sendJson(res, 200, { ok: true, attachment: await saveUploadedFile(req) });
    }

    if (url.pathname === "/api/files/view" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, file: await readReferencedFile(url.searchParams) });
    }

    if (url.pathname === "/api/files/download" && (req.method === "GET" || req.method === "HEAD")) {
      return sendReferencedFile(url.searchParams, res, req.method === "HEAD", false, req.headers.range);
    }

    if (url.pathname === "/api/files/raw" && (req.method === "GET" || req.method === "HEAD")) {
      return sendReferencedFile(url.searchParams, res, req.method === "HEAD", true, req.headers.range);
    }

    if (url.pathname === "/api/files/explore" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, explorer: await exploreFiles(url.searchParams) });
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
  console.log(`auth mode: ${AUTH_MODE}`);
  if (AUTH_WARNING) {
    console.warn(AUTH_WARNING);
  }
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
  const session = currentSession(req);
  return {
    authenticated: Boolean(session),
    mode: AUTH_MODE,
    warning: AUTH_WARNING,
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

async function saveUploadedFile(req: IncomingMessage): Promise<Record<string, unknown>> {
  const encodedName = headerValue(req.headers["x-file-name"]);
  const originalName = encodedName ? decodeURIComponent(encodedName) : "upload";
  const safeName = safeUploadName(originalName);
  const uploadDir = path.resolve(process.env.CODEX_WEB_UI_UPLOAD_DIR || path.join(projectRoot, "data/uploads"));
  const body = await readBinaryBody(req, 50 * 1024 * 1024);
  if (body.length === 0) {
    throw new Error("Uploaded file is empty");
  }
  await mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `${Date.now()}-${crypto.randomUUID()}-${safeName}`);
  await writeFile(filePath, body, { flag: "wx" });
  return {
    path: filePath,
    displayPath: displayPath(filePath),
    name: originalName,
    size: body.length
  };
}

async function exploreFiles(searchParams: URLSearchParams): Promise<Record<string, unknown>> {
  const cwd = resolveFilesCwd(searchParams.get("cwd"));
  const currentPath = resolveFilesExplorerPath(cwd, searchParams.get("path"));
  const stats = statSync(currentPath);
  if (!stats.isDirectory()) {
    throw new Error("Explorer path is not a directory");
  }

  const trackedFiles = await gitTrackedFiles(cwd);
  const entries = new Map<string, Record<string, unknown>>();
  const relativeDir = normalizeRelativePath(path.relative(cwd, currentPath));
  const prefix = relativeDir ? `${relativeDir}/` : "";

  for (const trackedFile of trackedFiles) {
    const normalized = normalizeRelativePath(trackedFile);
    if (!normalized || hasHiddenPathSegment(normalized) || (prefix && !normalized.startsWith(prefix))) {
      continue;
    }
    const remainder = prefix ? normalized.slice(prefix.length) : normalized;
    if (!remainder || remainder.includes("../")) {
      continue;
    }
    const [name, ...rest] = remainder.split("/");
    if (!name || isHiddenName(name)) {
      continue;
    }
    const entryPath = path.join(currentPath, name);
    const isFile = rest.length === 0;
    entries.set(name, fileExplorerEntry(entryPath, cwd, isFile ? "file" : "directory", true));
  }

  const actualEntries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of actualEntries) {
    if (isHiddenName(entry.name)) {
      continue;
    }
    const entryPath = path.join(currentPath, entry.name);
    let kind: "file" | "directory" | null = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;
    if (!kind && entry.isSymbolicLink()) {
      try {
        const linkedStats = statSync(entryPath);
        kind = linkedStats.isDirectory() ? "directory" : linkedStats.isFile() ? "file" : null;
      } catch {
        kind = null;
      }
    }
    if (!kind) {
      continue;
    }
    const previous = entries.get(entry.name);
    entries.set(entry.name, { ...fileExplorerEntry(entryPath, cwd, kind, Boolean(previous?.tracked)), tracked: Boolean(previous?.tracked) });
  }

  const sortedEntries = [...entries.values()].sort((a, b) => {
    const aType = a.type === "directory" ? 0 : 1;
    const bType = b.type === "directory" ? 0 : 1;
    return aType - bType || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
  });

  return {
    cwd,
    path: currentPath,
    relativePath: normalizeRelativePath(path.relative(cwd, currentPath)),
    displayPath: displayPath(currentPath),
    parentPath: currentPath === cwd ? null : path.dirname(currentPath),
    trackedCount: trackedFiles.length,
    entries: sortedEntries
  };
}

function fileExplorerEntry(filePath: string, cwd: string, type: "file" | "directory", tracked: boolean): Record<string, unknown> {
  let size: number | null = null;
  let modifiedAt: number | null = null;
  try {
    const stats = statSync(filePath);
    size = stats.isFile() ? stats.size : null;
    modifiedAt = Math.round(stats.mtimeMs);
  } catch {
    size = null;
    modifiedAt = null;
  }
  const kind = type === "file" ? previewKindForPath(filePath) : null;
  return {
    name: path.basename(filePath),
    path: filePath,
    relativePath: normalizeRelativePath(path.relative(cwd, filePath)),
    displayPath: displayPath(filePath),
    type,
    tracked,
    size,
    modifiedAt,
    kind: kind || null,
    previewable: type === "file" && Boolean(kind)
  };
}

async function readReferencedFile(searchParams: URLSearchParams): Promise<Record<string, unknown>> {
  const filePath = resolveReferencedFilePath(searchParams.get("path"), searchParams.get("cwd"));
  const stats = statSync(filePath);
  if (!stats.isFile()) {
    throw new Error("Referenced path is not a file");
  }
  const kind = previewKindForPath(filePath);
  const maxBytes = 2 * 1024 * 1024;
  if (kind === "image" || kind === "pdf" || kind === "video") {
    return fileMetadata(filePath, stats.size, kind, true);
  }
  if (!kind || stats.size > maxBytes) {
    return fileMetadata(filePath, stats.size, kind, false);
  }
  const content = await readFile(filePath, "utf8");
  return {
    ...fileMetadata(filePath, stats.size, kind, true),
    content
  };
}

function sendReferencedFile(searchParams: URLSearchParams, res: ServerResponse, headOnly: boolean, inline = false, rangeHeader?: string | string[]): void {
  const filePath = resolveReferencedFilePath(searchParams.get("path"), searchParams.get("cwd"));
  const stats = statSync(filePath);
  if (!stats.isFile()) {
    return sendJson(res, 404, { ok: false, error: "Referenced path is not a file" });
  }
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const range = parseRangeHeader(headerValue(rangeHeader), stats.size);
  if (rangeHeader && !range) {
    res.writeHead(416, {
      "Content-Range": `bytes */${stats.size}`,
      "Accept-Ranges": "bytes"
    });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stats.size - 1;
  const contentLength = end - start + 1;
  res.writeHead(range ? 206 : 200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Content-Length": String(contentLength),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fileName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "private, max-age=60",
    "Accept-Ranges": "bytes",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${stats.size}` } : {})
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

function resolveReferencedFilePath(inputPath: string | null, cwd: string | null): string {
  const value = inputPath?.trim();
  if (!value) {
    throw new Error("Missing file path");
  }
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return path.resolve(homeDir, value.slice(2));
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  const base = cwd?.trim() ? path.resolve(cwd) : bridge.summary().cwd;
  return path.resolve(typeof base === "string" ? base : projectRoot, value);
}

function fileMetadata(filePath: string, size: number, kind: string | null, previewable: boolean): Record<string, unknown> {
  return {
    path: filePath,
    displayPath: displayPath(filePath),
    name: path.basename(filePath),
    extension: path.extname(filePath).slice(1).toLowerCase(),
    mimeType: mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    size,
    kind: kind || "download",
    previewable
  };
}

function previewKindForPath(filePath: string): string | null {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["mp4", "m4v", "webm", "mov", "ogv", "ogg", "avi", "mkv", "3gp"].includes(ext)) return "video";
  if (ext === "json") return "json";
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (["txt", "log", "csv", "yaml", "yml", "toml", "ini", "env"].includes(ext)) return "text";
  if (["js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "rb", "php", "sh", "bash", "zsh", "fish", "sql", "css", "scss", "html", "xml", "vue", "svelte", "dockerfile"].includes(ext)) {
    return "code";
  }
  return null;
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function parseRangeHeader(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return null;
  }

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1
    };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return null;
  }
  return {
    start,
    end: Math.min(end, size - 1)
  };
}

function safeUploadName(name: string): string {
  const baseName = path.basename(name || "upload").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return baseName || "upload";
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

function resolveFilesCwd(inputCwd: string | null): string {
  const summary = bridge.summary();
  const fallback = typeof summary.cwd === "string" && summary.cwd ? summary.cwd : projectRoot;
  return resolveReferencedFilePath(inputCwd?.trim() || fallback, null);
}

function resolveFilesExplorerPath(cwd: string, inputPath: string | null): string {
  const value = inputPath?.trim();
  if (!value) {
    return cwd;
  }
  const filePath = resolveReferencedFilePath(value, cwd);
  if (!isPathWithin(cwd, filePath)) {
    throw new Error("Explorer path must stay within the working directory");
  }
  return filePath;
}

async function gitTrackedFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "ls-files", "-z"], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(stdout.split("\0").filter(Boolean));
    });
  });
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function hasHiddenPathSegment(value: string): boolean {
  return value.split("/").some(isHiddenName);
}

function isHiddenName(value: string): boolean {
  return value.startsWith(".");
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return !relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
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
  const text = (await readBinaryBody(req, 1_000_000)).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function readBinaryBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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
