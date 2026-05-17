export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: JsonValue;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: string | number;
  result?: JsonValue;
  error?: {
    code: number;
    message: string;
    data?: JsonValue;
  };
}

export interface ThreadRecord {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  sessionId?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: JsonValue;
  source?: JsonValue;
  turns?: JsonValue[];
  [key: string]: JsonValue | undefined;
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
  type: "rpc-request" | "rpc-response" | "notification" | "stderr" | "stdout" | "server" | "client-request";
  threadId?: string;
  method?: string;
  id?: string | number;
  payload?: JsonValue;
}

export interface ServerStatus {
  state: "stopped" | "starting" | "running" | "exited" | "error" | "disconnected";
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
}
