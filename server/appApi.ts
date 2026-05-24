import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { authState, isAuthenticated, loginWithPassword } from "./auth";
import { corsHeaders } from "./cors";
import {
  isMcpOAuthCallbackPath,
  mcpOAuthCallbackBaseUrl,
  mcpOAuthCallbackPort,
  registerMcpOAuthCallback,
  relayMcpOAuthCallback
} from "./mcpOAuthRelay";
import { codexConfigPath, saveMcpServerConfig } from "./mcpConfig";
import { enforceRpcPermissions } from "./permissions";
import { getRuntime, homeDir, projectRoot } from "./runtime";
import type { JsonValue } from "./types";

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

export async function handleApiRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (isMcpOAuthCallbackPath(url.pathname)) {
    return relayMcpOAuthCallback(request);
  }

  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") {
    return cors.allowed
      ? withCors(new Response(null, { status: 204, headers: noStoreHeaders() }), cors.headers)
      : json({ ok: false, error: "Origin is not allowed" }, 403, cors.headers);
  }
  if (!cors.allowed) {
    return json({ ok: false, error: "Origin is not allowed" }, 403, cors.headers);
  }

  const startedAt = Date.now();
  const { logs } = await getRuntime();
  try {
    const response = await dispatchApiRequest(request, url, cors.headers);
    void logs.append({
      type: "server",
      method: "http/request",
      payload: {
        method: request.method,
        path: url.pathname,
        statusCode: response.status,
        durationMs: Date.now() - startedAt
      }
    });
    return response;
  } catch (error) {
    const err = error as Error & { data?: unknown; statusCode?: number };
    const response = json({ ok: false, error: err.message || "Internal server error", data: err.data }, err.statusCode || 500, cors.headers);
    void logs.append({
      type: "server",
      method: "http/request",
      payload: {
        method: request.method,
        path: url.pathname,
        statusCode: response.status,
        durationMs: Date.now() - startedAt
      }
    });
    return response;
  }
}

async function dispatchApiRequest(request: Request, url: URL, cors: Headers): Promise<Response> {
  const { bridge, hub, logs } = await getRuntime();
  const pathname = url.pathname;

  if (pathname === "/api/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    return json({ ok: true, ...loginWithPassword(body.password) }, 200, cors);
  }

  if (pathname === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, cors);
  }

  if (pathname === "/api/auth" && request.method === "GET") {
    return json({ ok: true, ...authState(request) }, 200, cors);
  }

  if (!isAuthenticated(request)) {
    return json({ ok: false, error: "Unauthorized" }, 401, cors);
  }

  if (pathname === "/api/status" && request.method === "GET") {
    return json({ ok: true, status: bridge.summary() }, 200, cors);
  }

  if (pathname === "/api/events" && request.method === "GET") {
    bridge.start().catch((error: Error) => {
      hub.broadcast("server-status", bridge.summary());
      hub.broadcast("stderr", { at: Date.now(), line: error.message });
    });
    return withCors(
      new Response(hub.stream(request.signal), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        }
      }),
      cors
    );
  }

  if (pathname === "/api/rpc" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (typeof body.method !== "string") {
      return json({ ok: false, error: "Missing JSON-RPC method" }, 400, cors);
    }
    const params = enforceRpcPermissions(body.method, (body.params ?? {}) as JsonValue);
    const result = await bridge.request(body.method, params);
    return json({ ok: true, result }, 200, cors);
  }

  if (pathname === "/api/mcp/servers" && request.method === "GET") {
    return json({ ok: true, mcp: await listMcpServers() }, 200, cors);
  }

  if (pathname === "/api/mcp/servers" && request.method === "POST") {
    const body = await readJsonBody(request);
    await saveMcpServerConfig({
      name: body.name as string,
      url: body.url as string
    });
    return json({ ok: true, mcp: await reloadMcpServers() }, 200, cors);
  }

  if (pathname === "/api/mcp/servers/oauth/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return json({ ok: false, error: "Missing MCP server name" }, 400, cors);
    }
    await configureMcpOAuthRelay(request);
    const result = asRecord(await bridge.request("mcpServer/oauth/login", { name }));
    const authorizationUrl = typeof result.authorization_url === "string"
      ? result.authorization_url
      : typeof result.authorizationUrl === "string"
        ? result.authorizationUrl
        : "";
    if (!authorizationUrl) {
      return json({ ok: false, error: "Codex did not return an MCP OAuth authorization URL" }, 502, cors);
    }
    registerMcpOAuthCallback(name, authorizationUrl);
    return json({ ok: true, authorizationUrl }, 200, cors);
  }

  if (pathname === "/api/mcp/servers/reload" && request.method === "POST") {
    return json({ ok: true, mcp: await reloadMcpServers() }, 200, cors);
  }

  if (pathname === "/api/client-requests" && request.method === "GET") {
    return json({ ok: true, requests: bridge.pendingClientRequests() }, 200, cors);
  }

  if (pathname === "/api/client-requests/respond" && request.method === "POST") {
    const body = await readJsonBody(request);
    const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
    if (id === null) {
      return json({ ok: false, error: "Missing client request id" }, 400, cors);
    }
    bridge.respondClientRequest(id, (body.result ?? {}) as JsonValue);
    return json({ ok: true }, 200, cors);
  }

  if (pathname === "/api/uploads" && request.method === "POST") {
    return json({ ok: true, attachment: await saveUploadedFile(request) }, 200, cors);
  }

  if (pathname === "/api/transcribe" && request.method === "POST") {
    return json({ ok: true, transcript: await transcribeAudio(request) }, 200, cors);
  }

  if (pathname === "/api/files/view" && request.method === "GET") {
    return json({ ok: true, file: await readReferencedFile(url.searchParams) }, 200, cors);
  }

  if (pathname === "/api/files/download" && (request.method === "GET" || request.method === "HEAD")) {
    return withCors(await sendReferencedFile(url.searchParams, request.method === "HEAD", false, request.headers.get("range")), cors);
  }

  if (pathname === "/api/files/raw" && (request.method === "GET" || request.method === "HEAD")) {
    return withCors(await sendReferencedFile(url.searchParams, request.method === "HEAD", true, request.headers.get("range")), cors);
  }

  if (pathname === "/api/files/explore" && request.method === "GET") {
    return json({ ok: true, explorer: await exploreFiles(url.searchParams) }, 200, cors);
  }

  if (pathname === "/api/skills" && request.method === "GET") {
    const summary = bridge.summary();
    return json({ ok: true, skills: await listSkills(typeof summary.cwd === "string" ? summary.cwd : null) }, 200, cors);
  }

  if (pathname === "/api/server/restart" && request.method === "POST") {
    await bridge.restart();
    return json({ ok: true, status: bridge.summary() }, 200, cors);
  }

  if (pathname === "/api/app-server/recover" && request.method === "POST") {
    const output = await recoverAppServerSidecar();
    await bridge.restart();
    return json({ ok: true, output, status: bridge.summary() }, 200, cors);
  }

  if (pathname === "/api/server/stop" && request.method === "POST") {
    await bridge.stop();
    return json({ ok: true, status: bridge.summary() }, 200, cors);
  }

  if (pathname === "/api/repositories/browse" && request.method === "GET") {
    return json({ ok: true, browser: await browseRepositories(url.searchParams.get("path")) }, 200, cors);
  }

  if (pathname === "/api/repositories/create" && request.method === "POST") {
    const body = await readJsonBody(request);
    return json({ ok: true, browser: await createRepository(body.parentPath, body.name) }, 200, cors);
  }

  if (pathname.startsWith("/api/logs/") && request.method === "DELETE") {
    const threadId = decodeURIComponent(pathname.slice("/api/logs/".length));
    return json({ ok: true, threadId, deleted: await logs.deleteThreadLog(threadId) }, 200, cors);
  }

  return json({ ok: false, error: "Not found" }, 404, cors);
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

async function reloadMcpServers(): Promise<Record<string, unknown>> {
  const { bridge } = await getRuntime();
  await bridge.request("config/mcpServer/reload", {});
  return listMcpServers();
}

async function configureMcpOAuthRelay(request: Request): Promise<void> {
  const { bridge } = await getRuntime();
  await bridge.request("config/batchWrite", {
    edits: [
      {
        keyPath: "mcp_oauth_callback_port",
        value: mcpOAuthCallbackPort(),
        mergeStrategy: "replace"
      },
      {
        keyPath: "mcp_oauth_callback_url",
        value: mcpOAuthCallbackBaseUrl(request),
        mergeStrategy: "replace"
      }
    ],
    reloadUserConfig: true
  });
}

async function listMcpServers(): Promise<Record<string, unknown>> {
  const { bridge } = await getRuntime();
  const response = asRecord(await bridge.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }));
  const data = Array.isArray(response.data) ? response.data.map(summarizeMcpServer) : [];
  return {
    configPath: codexConfigPath(),
    servers: data,
    nextCursor: typeof response.nextCursor === "string" ? response.nextCursor : null
  };
}

function summarizeMcpServer(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const tools = asRecord(record.tools);
  return {
    name: typeof record.name === "string" ? record.name : "unknown",
    authStatus: typeof record.authStatus === "string" ? record.authStatus : "unsupported",
    tools: Object.keys(tools).sort(),
    resources: Array.isArray(record.resources) ? record.resources.length : 0,
    resourceTemplates: Array.isArray(record.resourceTemplates) ? record.resourceTemplates.length : 0
  };
}

async function saveUploadedFile(request: Request): Promise<Record<string, unknown>> {
  const encodedName = request.headers.get("x-file-name") || "";
  const originalName = encodedName ? decodeURIComponent(encodedName) : "upload";
  const safeName = safeUploadName(originalName);
  const uploadDir = path.resolve(process.env.CODEX_WEB_UI_UPLOAD_DIR || path.join(projectRoot, "data/uploads"));
  const body = await readBinaryBody(request, 50 * 1024 * 1024);
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

async function transcribeAudio(request: Request): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.CODEX_WEB_UI_OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for audio transcription.");
  }
  const encodedName = request.headers.get("x-file-name") || "";
  const originalName = encodedName ? decodeURIComponent(encodedName) : "recording.webm";
  const body = await readBinaryBody(request, 25 * 1024 * 1024);
  if (body.length === 0) {
    throw new Error("Audio recording is empty.");
  }
  const form = new FormData();
  form.set("model", process.env.CODEX_WEB_UI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe");
  form.set("response_format", "json");
  form.set("file", new Blob([new Uint8Array(body)], { type: request.headers.get("content-type") || "audio/webm" }), safeUploadName(originalName));
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });
  const result = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    const error = asRecord(result.error);
    throw new Error(typeof error.message === "string" ? error.message : `Transcription failed: ${response.status}`);
  }
  return typeof result.text === "string" ? result.text.trim() : "";
}

async function exploreFiles(searchParams: URLSearchParams): Promise<Record<string, unknown>> {
  const cwd = await resolveFilesCwd(searchParams.get("cwd"));
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

async function listSkills(cwd: string | null): Promise<Record<string, unknown>[]> {
  const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(homeDir, ".codex");
  const sources = [
    { source: "workspace", path: cwd ? path.join(cwd, ".codex", "skills") : "" },
    { source: "project", path: path.join(projectRoot, ".codex", "skills") },
    { source: "user", path: path.join(codexHome, "skills") }
  ].filter((source) => source.path);
  const byName = new Map<string, Record<string, unknown>>();
  for (const source of sources) {
    for (const skill of await readSkillsFromDirectory(source.path, source.source)) {
      const name = String(skill.name);
      if (!byName.has(name)) {
        byName.set(name, skill);
      }
    }
  }
  return [...byName.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
}

async function readSkillsFromDirectory(root: string, source: string): Promise<Record<string, unknown>[]> {
  if (!existsSync(root)) {
    return [];
  }
  const results: Record<string, unknown>[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.name === ".system") {
      results.push(...await readSkillsFromDirectory(entryPath, "system"));
      continue;
    }
    const skillFile = path.join(entryPath, "SKILL.md");
    if (!existsSync(skillFile)) {
      continue;
    }
    results.push({
      name: entry.name,
      path: entryPath,
      source,
      description: await readSkillDescription(skillFile)
    });
  }
  return results;
}

async function readSkillDescription(skillFile: string): Promise<string | null> {
  const content = await readFile(skillFile, "utf8").catch(() => "");
  const description = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("---"));
  return description ? truncateText(description.replace(/^description:\s*/i, "").replace(/^["']|["']$/g, ""), 220) : null;
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}...`;
}

async function readReferencedFile(searchParams: URLSearchParams): Promise<Record<string, unknown>> {
  const filePath = await resolveReferencedFilePath(searchParams.get("path"), searchParams.get("cwd"));
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

async function sendReferencedFile(searchParams: URLSearchParams, headOnly: boolean, inline = false, rangeHeader?: string | null): Promise<Response> {
  const filePath = await resolveReferencedFilePath(searchParams.get("path"), searchParams.get("cwd"));
  const stats = statSync(filePath);
  if (!stats.isFile()) {
    return json({ ok: false, error: "Referenced path is not a file" }, 404);
  }
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const range = parseRangeHeader(rangeHeader || "", stats.size);
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${stats.size}`,
        "Accept-Ranges": "bytes"
      }
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stats.size - 1;
  const contentLength = end - start + 1;
  const headers = new Headers({
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Content-Length": String(contentLength),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fileName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "private, max-age=60",
    "Accept-Ranges": "bytes",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${stats.size}` } : {})
  });
  const body = headOnly ? null : (Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>);
  return new Response(body, { status: range ? 206 : 200, headers });
}

async function resolveReferencedFilePath(inputPath: string | null, cwd: string | null): Promise<string> {
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
  const { bridge } = await getRuntime();
  const summary = bridge.summary();
  const base = cwd?.trim() ? path.resolve(cwd) : summary.cwd;
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

async function resolveFilesCwd(inputCwd: string | null): Promise<string> {
  const { bridge } = await getRuntime();
  const summary = bridge.summary();
  const fallback = typeof summary.cwd === "string" && summary.cwd ? summary.cwd : projectRoot;
  return resolveReferencedFilePath(inputCwd?.trim() || fallback, null);
}

function resolveFilesExplorerPath(cwd: string, inputPath: string | null): string {
  const value = inputPath?.trim();
  if (!value) {
    return cwd;
  }
  const filePath = path.resolve(path.isAbsolute(value) ? value : path.join(cwd, value));
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

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = (await readBinaryBody(request, 1_000_000)).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function readBinaryBody(request: Request, limitBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    throw new Error("Request body is too large");
  }
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > limitBytes) {
    throw new Error("Request body is too large");
  }
  return body;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function json(payload: unknown, status = 200, cors?: Headers): Response {
  return withCors(
    Response.json(payload, {
      status,
      headers: noStoreHeaders()
    }),
    cors
  );
}

async function recoverAppServerSidecar(): Promise<string> {
  const socket = process.env.CODEX_APP_SERVER_SOCKET;
  if (!socket) {
    throw new Error("CODEX_APP_SERVER_SOCKET is not configured; this server owns its app-server connection.");
  }
  const binPath = process.env.CODEX_WEB_UI_BIN || path.join(projectRoot, "bin", "codex-web-ui.js");
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [binPath, "app-server", "recover", "--socket", socket], { cwd: projectRoot, env: process.env, timeout: 12_000 }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (error) {
        const message = output || error.message;
        reject(new Error(message));
        return;
      }
      resolve(output);
    });
  });
}

function noStoreHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store"
  });
}

function withCors(response: Response, cors?: Headers): Response {
  for (const [key, value] of cors ?? []) {
    response.headers.set(key, value);
  }
  return response;
}
