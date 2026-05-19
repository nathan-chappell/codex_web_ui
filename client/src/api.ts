import type { AuthState, FileExplorer, FilePreview, FileReference, JsonValue, RepositoryBrowser, ServerEvent, ServerStatus, UploadedAttachment } from "./types";

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

export async function createRepository(parentPath: string, name: string): Promise<RepositoryBrowser> {
  const body = await postJson<{ browser: RepositoryBrowser }>("/api/repositories/create", { parentPath, name });
  return body.browser;
}

export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const response = await fetch("/api/uploads", {
    method: "POST",
    credentials: "same-origin",
    headers: {
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

export function referencedFileDownloadUrl(reference: FileReference): string {
  return fileQueryUrl("/api/files/download", reference);
}

export function referencedFileRawUrl(reference: FileReference): string {
  return fileQueryUrl("/api/files/raw", reference);
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

function fileQueryUrl(baseUrl: string, reference: FileReference): string {
  const params = new URLSearchParams({ path: reference.path });
  if (reference.cwd) {
    params.set("cwd", reference.cwd);
  }
  return `${baseUrl}?${params.toString()}`;
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
