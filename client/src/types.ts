export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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

export interface UiSettings {
  cwd: string;
  model: string;
  effort: string;
  approvalPolicy: string;
  sandbox: string;
}
