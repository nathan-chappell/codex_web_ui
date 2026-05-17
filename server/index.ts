import crypto from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexBridge } from "./codexBridge.js";
import { EventHub } from "./eventHub.js";
import { SessionLogStore } from "./logStore.js";
import type { JsonValue } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, "../public");
const projectRoot = path.resolve(__dirname, "../..");

loadEnvFile(path.join(projectRoot, ".env"));

const PORT = Number(process.env.PORT || 4545);
const HOST = process.env.HOST || "127.0.0.1";
const PASSWORD = process.env.CODEX_WEB_UI_PASSWORD || "codex";
const SESSION_COOKIE = "codex_web_ui_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const logs = new SessionLogStore(process.env.CODEX_WEB_UI_DATA_DIR || path.join(projectRoot, "data"));
const hub = new EventHub();
const bridge = new CodexBridge(
  {
    command: process.env.CODEX_COMMAND || "codex",
    cwd: process.env.CODEX_CWD || projectRoot,
    model: process.env.CODEX_MODEL || "",
    reasoningEffort: process.env.CODEX_REASONING_EFFORT || "",
    fastMode: process.env.CODEX_FAST_MODE === "1"
  },
  hub,
  logs
);

const sessions = new Map<string, { createdAt: number }>();

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

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!safePasswordEquals(typeof body.password === "string" ? body.password : "")) {
        return sendJson(res, 401, { ok: false, error: "Invalid password" });
      }
      const token = crypto.randomBytes(32).toString("base64url");
      sessions.set(token, { createdAt: Date.now() });
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
      return sendJson(res, 200, { ok: true, authenticated: isAuthenticated(req) });
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

    if (url.pathname === "/api/logs" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, sessions: await logs.listSessions() });
    }

    if (url.pathname.startsWith("/api/logs/") && req.method === "GET") {
      const threadId = decodeURIComponent(url.pathname.slice("/api/logs/".length));
      return sendJson(res, 200, { ok: true, threadId, entries: await logs.readThreadLog(threadId) });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    return serveStatic(url.pathname, res, req.method === "HEAD");
  } catch (error) {
    const err = error as Error & { data?: unknown };
    return sendJson(res, 500, { ok: false, error: err.message || "Internal server error", data: err.data });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`codex-web-ui listening on http://${HOST}:${PORT}`);
  console.log(`password source: ${process.env.CODEX_WEB_UI_PASSWORD ? "CODEX_WEB_UI_PASSWORD" : "hardcoded fallback"}`);
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

async function shutdown(): Promise<void> {
  await bridge.stop();
  process.exit(0);
}

function isAuthenticated(req: IncomingMessage): boolean {
  const token = getSessionToken(req);
  if (!token) {
    return false;
  }
  const session = sessions.get(token);
  if (!session) {
    return false;
  }
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
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

function safePasswordEquals(value: string): boolean {
  const provided = Buffer.from(value);
  const expected = Buffer.from(PASSWORD);
  if (provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(provided, expected);
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
