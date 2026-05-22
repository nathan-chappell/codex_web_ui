export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AuthMode = "password";

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
}

export interface AuthState {
  authenticated: boolean;
  mode: AuthMode;
  warning?: string | null;
  user?: AuthUser | null;
  tokenExpiresAt?: number | null;
  permissionPolicy?: PermissionPolicy;
}

export interface PermissionPolicy {
  defaultApprovalPolicy: string;
  defaultSandbox: string;
  locked: boolean;
  unsafePermissions: boolean;
  allowedApprovalPolicies: string[];
  allowedSandboxes: string[];
}

export interface Thread {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  sessionId?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: string | { type: string; activeFlags?: string[] };
  turns?: Turn[];
  [key: string]: unknown;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

export interface UploadedAttachment {
  path: string;
  displayPath: string;
  name: string;
  size: number;
}

export interface FileReference {
  path: string;
  cwd?: string | null;
  label?: string;
}

export interface FilePreview {
  path: string;
  displayPath: string;
  name: string;
  extension: string;
  mimeType?: string;
  size: number;
  kind: "json" | "markdown" | "code" | "text" | "image" | "pdf" | "video" | "download" | string;
  previewable: boolean;
  content?: string;
}

export interface FileExplorerEntry {
  name: string;
  path: string;
  relativePath: string;
  displayPath: string;
  type: "file" | "directory";
  tracked: boolean;
  size: number | null;
  modifiedAt: number | null;
  kind: string | null;
  previewable: boolean;
}

export interface FileExplorer {
  cwd: string;
  path: string;
  relativePath: string;
  displayPath: string;
  parentPath: string | null;
  trackedCount: number;
  entries: FileExplorerEntry[];
}

export interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress" | string;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  items?: ThreadItem[];
  error?: unknown;
}

export interface ThreadItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface SessionIndexRecord {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  sessionId: string;
  createdAt: number | null;
  updatedAt: number | null;
  status: JsonValue | null;
  logPath: string;
  lastLoggedAt: string;
}

export interface LogEntry {
  at: string;
  type: string;
  threadId?: string;
  method?: string;
  id?: string | number;
  payload?: unknown;
}

export interface ServerStatus {
  state: string;
  command?: string;
  cwd?: string;
  pid?: number | null;
  error?: string | null;
  stderr?: { at: number; line: string }[];
  config?: Record<string, unknown>;
}

export interface ServerEvent {
  type: string;
  payload: unknown;
  at: number;
}

export interface ClientRequest {
  id: string | number;
  method: string;
  params: JsonValue;
  receivedAt: number;
}

export interface RepositoryEntry {
  name: string;
  path: string;
  displayPath: string;
  isGitRepo: boolean;
  hidden: boolean;
}

export interface RepositoryBrowser {
  path: string;
  displayPath: string;
  parentPath: string | null;
  homePath: string;
  isGitRepo: boolean;
  entries: RepositoryEntry[];
}

export interface McpServerStatus {
  name: string;
  authStatus: string;
  tools: string[];
  resources: number;
  resourceTemplates: number;
}

export interface McpServerList {
  configPath: string;
  servers: McpServerStatus[];
  nextCursor: string | null;
}

export interface UiSettings {
  cwd: string;
  model: string;
  effort: string;
  approvalPolicy: string;
  sandbox: string;
}
