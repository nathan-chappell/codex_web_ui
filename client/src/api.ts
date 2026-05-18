import type { AuthState, JsonValue, RepositoryBrowser, ServerEvent, ServerStatus } from "./types";

export async function getAuth(): Promise<AuthState> {
  const body = await getJson<AuthState>("/api/auth");
  return body;
}

export async function login(password: string): Promise<void> {
  await postJson("/api/login", { password });
}

export async function createClerkSession(token: string): Promise<void> {
  await postJson("/api/clerk/session", { token });
}

export async function logout(): Promise<void> {
  await postJson("/api/logout", {});
}

export async function getStatus(): Promise<ServerStatus> {
  const body = await getJson<{ status: ServerStatus }>("/api/status");
  return body.status;
}

export async function restartServer(): Promise<ServerStatus> {
  const body = await postJson<{ status: ServerStatus }>("/api/server/restart", {});
  return body.status;
}

export async function rpc<T = unknown>(method: string, params: JsonValue = {}): Promise<T> {
  const body = await postJson<{ result: T }>("/api/rpc", { method, params });
  return body.result;
}

export async function deleteThreadLog(threadId: string): Promise<void> {
  await deleteJson(`/api/logs/${encodeURIComponent(threadId)}`);
}

export async function browseRepositories(path?: string): Promise<RepositoryBrowser> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const body = await getJson<{ browser: RepositoryBrowser }>(`/api/repositories/browse${query}`);
  return body.browser;
}

export async function createRepository(parentPath: string, name: string): Promise<RepositoryBrowser> {
  const body = await postJson<{ browser: RepositoryBrowser }>("/api/repositories/create", { parentPath, name });
  return body.browser;
}

export function openEventStream(onEvent: (event: ServerEvent) => void, onHello: (events: ServerEvent[]) => void): EventSource {
  const source = new EventSource("/api/events");
  source.addEventListener("hello", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { history?: ServerEvent[] };
    onHello(payload.history ?? []);
  });
  source.addEventListener("message", (event) => {
    onEvent(JSON.parse((event as MessageEvent).data) as ServerEvent);
  });
  return source;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  return parseResponse<T>(response);
}

async function postJson<T = unknown>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseResponse<T>(response);
}

async function deleteJson<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    credentials: "same-origin"
  });
  return parseResponse<T>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; data?: unknown };
  if (!response.ok) {
    const error = new Error(body.error || `Request failed: ${response.status}`) as Error & { data?: unknown };
    error.data = body.data;
    throw error;
  }
  return body as T;
}
