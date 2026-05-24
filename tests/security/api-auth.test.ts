import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.CODEX_WEB_UI_PASSWORD = "test-password";
process.env.CODEX_WEB_UI_AUTH_SECRET = "test-auth-secret";
process.env.CODEX_WEB_UI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "codex-web-ui-security-"));
process.env.CODEX_WEB_UI_UPLOAD_DIR = path.join(process.env.CODEX_WEB_UI_DATA_DIR, "uploads");
process.env.CODEX_APP_SERVER_SOCKET = path.join(process.env.CODEX_WEB_UI_DATA_DIR, "missing.sock");
process.env.CODEX_CWD = process.cwd();

const { handleApiRequest } = await import("../../server/appApi");

const protectedRoutes: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: "/api/status" },
  { method: "GET", path: "/api/events" },
  { method: "POST", path: "/api/rpc", body: { method: "thread/list", params: {} } },
  { method: "GET", path: "/api/mcp/servers" },
  { method: "POST", path: "/api/mcp/servers", body: { name: "local", url: "http://127.0.0.1:3000/api/mcp" } },
  { method: "POST", path: "/api/mcp/servers/oauth/login", body: { name: "local" } },
  { method: "POST", path: "/api/mcp/servers/reload", body: {} },
  { method: "GET", path: "/api/client-requests" },
  { method: "POST", path: "/api/client-requests/respond", body: { id: "1", result: {} } },
  { method: "POST", path: "/api/uploads", body: "file" },
  { method: "POST", path: "/api/transcribe", body: "audio" },
  { method: "GET", path: "/api/files/view?path=README.md" },
  { method: "GET", path: "/api/files/download?path=README.md" },
  { method: "HEAD", path: "/api/files/raw?path=README.md" },
  { method: "GET", path: "/api/files/explore" },
  { method: "GET", path: "/api/skills" },
  { method: "POST", path: "/api/server/restart", body: {} },
  { method: "POST", path: "/api/app-server/recover", body: {} },
  { method: "POST", path: "/api/server/stop", body: {} },
  { method: "GET", path: "/api/repositories/browse" },
  { method: "POST", path: "/api/repositories/create", body: { parentPath: process.cwd(), name: "repo" } },
  { method: "DELETE", path: "/api/logs/thread-id" }
];

test("public auth endpoints do not expose an authenticated session without a bearer token", async () => {
  const response = await request("GET", "/api/auth");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.authenticated, false);
  assert.equal(body.user, null);
});

test("login rejects an invalid password", async () => {
  const response = await request("POST", "/api/login", { password: "wrong" });
  assert.equal(response.status, 401);
});

test("protected API routes reject missing bearer tokens", async () => {
  for (const route of protectedRoutes) {
    const response = await request(route.method, route.path, route.body);
    assert.equal(response.status, 401, `${route.method} ${route.path}`);
    if (route.method !== "HEAD") {
      const body = await response.json();
      assert.equal(body.error, "Unauthorized", `${route.method} ${route.path}`);
    }
  }
});

test("CORS rejects explicitly disallowed foreign origins before auth", async () => {
  const response = await request("GET", "/api/auth", undefined, {
    Origin: "https://attacker.example"
  });
  assert.equal(response.status, 403);
});

test("OAuth callback remains public but single-use relay state is required", async () => {
  const response = await request("GET", "/api/mcp/oauth/callback/test?state=missing");
  assert.equal(response.status, 403);
  assert.match(await response.text(), /expired|already used/i);
});

test("valid bearer token can read status without starting the app-server", async () => {
  const loginResponse = await request("POST", "/api/login", { password: "test-password" });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.equal(typeof loginBody.token, "string");

  const response = await request("GET", "/api/status", undefined, {
    Authorization: `Bearer ${loginBody.token}`
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.status, "object");
});

test("file explorer stays inside the selected working directory", async () => {
  const loginResponse = await request("POST", "/api/login", { password: "test-password" });
  const { token } = await loginResponse.json();
  const response = await request("GET", `/api/files/explore?cwd=${encodeURIComponent(process.cwd())}&path=..`, undefined, {
    Authorization: `Bearer ${token}`
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.error, /must stay within/i);
});

function request(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const requestHeaders = new Headers(headers);
  const init: RequestInit = { method, headers: requestHeaders };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    if (typeof body === "string") {
      init.body = body;
    } else {
      requestHeaders.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }
  }
  return handleApiRequest(new Request(`http://127.0.0.1:4545${pathname}`, init));
}
