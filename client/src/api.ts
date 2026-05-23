import type { AuthState, ClientRequest, FileExplorer, FilePreview, FileReference, JsonValue, McpServerList, RepositoryBrowser, ServerEvent, ServerStatus, SkillReference, UploadedAttachment } from "./types";

const AUTH_TOKEN_STORAGE_KEY = "codex-web-ui-auth-token-v1";
export const AUTH_UNAUTHORIZED_EVENT = "codex-web-ui-auth-unauthorized";

export async function getAuth(): Promise<AuthState> {
  const body = await getJson<AuthState>("/api/auth");
  return body;
}

export async function login(password: string): Promise<AuthState> {
  const body = await postJson<AuthState & { token: string }>("/api/login", { password }, { skipAuth: true });
  setAuthToken(body.token);
  return body;
}

export async function logout(): Promise<void> {
  await postJson("/api/logout", {}).catch(() => undefined);
  clearAuthToken();
}

export async function getStatus(): Promise<ServerStatus> {
  const body = await getJson<{ status: ServerStatus }>("/api/status");
  return body.status;
}

export async function restartServer(): Promise<ServerStatus> {
  const body = await postJson<{ status: ServerStatus }>("/api/server/restart", {});
  return body.status;
}

export async function recoverAppServer(): Promise<{ output: string; status: ServerStatus }> {
  const body = await postJson<{ output: string; status: ServerStatus }>("/api/app-server/recover", {});
  return body;
}

export async function rpc<T = unknown>(method: string, params: JsonValue = {}): Promise<T> {
  const body = await postJson<{ result: T }>("/api/rpc", { method, params });
  return body.result;
}

export async function getClientRequests(): Promise<ClientRequest[]> {
  const body = await getJson<{ requests: ClientRequest[] }>("/api/client-requests");
  return body.requests;
}

export async function getMcpServers(): Promise<McpServerList> {
  const body = await getJson<{ mcp: McpServerList }>("/api/mcp/servers");
  return body.mcp;
}

export async function saveMcpServer(input: { name: string; url: string; bearerToken?: string }): Promise<McpServerList> {
  const payload: { name: string; url: string; bearerToken?: string } = {
    name: input.name,
    url: input.url
  };
  if (input.bearerToken?.trim()) {
    payload.bearerToken = input.bearerToken.trim();
  }
  const body = await postJson<{ mcp: McpServerList }>("/api/mcp/servers", payload);
  return body.mcp;
}

export async function reloadMcpServers(): Promise<McpServerList> {
  const body = await postJson<{ mcp: McpServerList }>("/api/mcp/servers/reload", {});
  return body.mcp;
}

export async function respondClientRequest(id: string | number, result: JsonValue): Promise<void> {
  await postJson("/api/client-requests/respond", { id, result });
}

export async function deleteThreadLog(threadId: string): Promise<void> {
  await deleteJson(`/api/logs/${encodeURIComponent(threadId)}`);
}

export async function browseRepositories(path?: string): Promise<RepositoryBrowser> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const body = await getJson<{ browser: RepositoryBrowser }>(`/api/repositories/browse${query}`);
  return body.browser;
}

export async function browseFiles(options: { cwd?: string | null; path?: string | null } = {}): Promise<FileExplorer> {
  const params = new URLSearchParams();
  if (options.cwd) {
    params.set("cwd", options.cwd);
  }
  if (options.path) {
    params.set("path", options.path);
  }
  const query = params.toString() ? `?${params.toString()}` : "";
  const body = await getJson<{ explorer: FileExplorer }>(`/api/files/explore${query}`);
  return body.explorer;
}

export async function listSkills(): Promise<SkillReference[]> {
  const body = await getJson<{ skills: SkillReference[] }>("/api/skills");
  return body.skills;
}

export async function createRepository(parentPath: string, name: string): Promise<RepositoryBrowser> {
  const body = await postJson<{ browser: RepositoryBrowser }>("/api/repositories/create", { parentPath, name });
  return body.browser;
}

export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const response = await fetch("/api/uploads", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name)
    },
    body: file
  });
  const body = await parseResponse<{ attachment: UploadedAttachment }>(response);
  return body.attachment;
}

export async function readReferencedFile(reference: FileReference): Promise<FilePreview> {
  const body = await getJson<{ file: FilePreview }>(fileQueryUrl("/api/files/view", reference));
  return body.file;
}

export async function fetchReferencedFileBlob(reference: FileReference, raw = false): Promise<Blob> {
  const response = await fetch(fileQueryUrl(raw ? "/api/files/raw" : "/api/files/download", reference), {
    headers: authHeaders()
  });
  await assertResponse(response);
  return response.blob();
}

export async function downloadReferencedFile(reference: FileReference, fileName: string): Promise<void> {
  const blob = await fetchReferencedFileBlob(reference);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export type AuthEventStream = {
  close: () => void;
  onerror?: () => void;
};

export function openEventStream(onEvent: (event: ServerEvent) => void, onHello: (events: ServerEvent[]) => void): AuthEventStream {
  const controller = new AbortController();
  const stream: AuthEventStream = {
    close: () => controller.abort()
  };
  void readEventStream(controller, stream, onEvent, onHello);
  return stream;
}

function fileQueryUrl(baseUrl: string, reference: FileReference): string {
  const params = new URLSearchParams({ path: reference.path });
  if (reference.cwd) {
    params.set("cwd", reference.cwd);
  }
  return `${baseUrl}?${params.toString()}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  return parseResponse<T>(response);
}

async function postJson<T = unknown>(url: string, payload: unknown, options: { skipAuth?: boolean } = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...(!options.skipAuth ? authHeaders() : {}), "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseResponse<T>(response);
}

async function deleteJson<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: authHeaders()
  });
  return parseResponse<T>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  await assertResponse(response);
  return response.json() as Promise<T>;
}

async function assertResponse(response: Response): Promise<void> {
  if (response.status === 401) {
    clearAuthToken();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
    }
  }
  if (response.ok) {
    return;
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string; data?: unknown };
  const error = new Error(body.error || `Request failed: ${response.status}`) as Error & { data?: unknown };
  error.data = body.data;
  throw error;
}

async function readEventStream(
  controller: AbortController,
  stream: AuthEventStream,
  onEvent: (event: ServerEvent) => void,
  onHello: (events: ServerEvent[]) => void
): Promise<void> {
  try {
    const response = await fetch("/api/events", {
      headers: authHeaders(),
      signal: controller.signal
    });
    await assertResponse(response);
    if (!response.body) {
      throw new Error("Event stream response did not include a body.");
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += value;
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        handleSseBlock(part, onEvent, onHello);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      stream.onerror?.();
    }
  }
}

function handleSseBlock(block: string, onEvent: (event: ServerEvent) => void, onHello: (events: ServerEvent[]) => void): void {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (!dataLines.length) {
    return;
  }
  const data = dataLines.join("\n");
  if (eventName === "hello") {
    const payload = JSON.parse(data) as { history?: ServerEvent[] };
    onHello(payload.history ?? []);
    return;
  }
  onEvent(JSON.parse(data) as ServerEvent);
}

function authHeaders(): Record<string, string> {
  const token = authToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function authToken(): string {
  return typeof window === "undefined" ? "" : window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || "";
}

function setAuthToken(token: string): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  }
}

function clearAuthToken(): void {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  }
}
