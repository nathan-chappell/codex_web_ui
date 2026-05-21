import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue, LogEntry, SessionIndexRecord, ThreadRecord } from "./types";

export class SessionLogStore {
  readonly rootDir: string;
  readonly sessionsDir: string;
  readonly globalLogPath: string;
  readonly indexPath: string;

  private index: Map<string, SessionIndexRecord> | null = null;
  private indexQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.sessionsDir = path.join(rootDir, "sessions");
    this.globalLogPath = path.join(rootDir, "server.jsonl");
    this.indexPath = path.join(rootDir, "sessions.json");
  }

  async ensure(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await this.loadIndex();
  }

  async append(entry: Omit<LogEntry, "at">): Promise<void> {
    const fullEntry: LogEntry = { at: new Date().toISOString(), ...entry };
    await this.ensure();
    await appendFile(this.globalLogPath, `${JSON.stringify(fullEntry)}\n`, "utf8");
    const threadIds = extractThreadIds(fullEntry);
    for (const threadId of threadIds) {
      await appendFile(this.threadLogPath(threadId), `${JSON.stringify({ ...fullEntry, threadId })}\n`, "utf8");
    }
  }

  async recordRpcRequest(method: string, id: string | number, params: JsonValue | undefined): Promise<void> {
    await this.append({
      type: "rpc-request",
      id,
      method,
      payload: jsonOrNull({ threadIds: threadIdsFromJson(params), params: summarizeRpcPayload(params) })
    });
  }

  async recordRpcResponse(
    method: string,
    id: string | number,
    result: JsonValue | undefined,
    error: JsonValue | undefined
  ): Promise<void> {
    if (result !== undefined) {
      await this.recordThreadsFromResult(result);
    }
    await this.append({
      type: "rpc-response",
      id,
      method,
      payload: jsonOrNull({ threadIds: threadIdsFromJson(result), result: summarizeRpcPayload(result), error })
    });
  }

  async recordNotification(method: string, params: JsonValue | undefined): Promise<void> {
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const thread = (params as Record<string, JsonValue>).thread;
      if (isThreadRecord(thread)) {
        await this.recordThread(thread);
      }
    }
    await this.append({ type: "notification", method, payload: jsonOrNull({ params }) });
  }

  async recordThreadsFromResult(result: JsonValue): Promise<void> {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return;
    }
    const record = result as Record<string, JsonValue>;
    if (isThreadRecord(record.thread)) {
      await this.recordThread(record.thread);
    }
    if (Array.isArray(record.data)) {
      for (const item of record.data) {
        if (isThreadRecord(item)) {
          await this.recordThread(item);
        }
      }
    }
  }

  async recordThread(thread: ThreadRecord): Promise<void> {
    await this.ensure();
    const index = await this.loadIndex();
    const previous = index.get(thread.id);
    const record: SessionIndexRecord = {
      id: thread.id,
      name: typeof thread.name === "string" ? thread.name : previous?.name ?? null,
      preview: typeof thread.preview === "string" ? thread.preview : previous?.preview ?? "",
      cwd: typeof thread.cwd === "string" ? thread.cwd : previous?.cwd ?? "",
      sessionId: typeof thread.sessionId === "string" ? thread.sessionId : previous?.sessionId ?? "",
      createdAt: typeof thread.createdAt === "number" ? thread.createdAt : previous?.createdAt ?? null,
      updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : previous?.updatedAt ?? null,
      status: thread.status ?? previous?.status ?? null,
      logPath: this.threadLogPath(thread.id),
      lastLoggedAt: new Date().toISOString()
    };
    index.set(thread.id, record);
    if (!existsSync(this.threadLogPath(thread.id))) {
      const entry: LogEntry = {
        at: new Date().toISOString(),
        type: "server",
        threadId: thread.id,
        method: "thread/indexed",
        payload: JSON.parse(JSON.stringify({ thread: record })) as JsonValue
      };
      await appendFile(this.threadLogPath(thread.id), `${JSON.stringify(entry)}\n`, "utf8");
    }
    await this.saveIndexQueued();
  }

  async deleteThreadLog(threadId: string): Promise<boolean> {
    await this.ensure();
    const index = await this.loadIndex();
    index.delete(threadId);
    await this.saveIndexQueued();
    const filePath = this.threadLogPath(threadId);
    if (!existsSync(filePath)) {
      return false;
    }
    await unlink(filePath);
    return true;
  }

  threadLogPath(threadId: string): string {
    return path.join(this.sessionsDir, `${safeFileName(threadId)}.jsonl`);
  }

  private async loadIndex(): Promise<Map<string, SessionIndexRecord>> {
    if (this.index) {
      return this.index;
    }
    await mkdir(this.sessionsDir, { recursive: true });
    if (!existsSync(this.indexPath)) {
      this.index = new Map();
      return this.index;
    }
    const raw = await readFile(this.indexPath, "utf8");
    const parsed = JSON.parse(raw || "{}") as Record<string, SessionIndexRecord>;
    this.index = new Map(Object.entries(parsed));
    return this.index;
  }

  private async saveIndexQueued(): Promise<void> {
    this.indexQueue = this.indexQueue.then(async () => {
      if (!this.index) {
        return;
      }
      const payload = Object.fromEntries([...this.index.entries()]);
      await writeFile(this.indexPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    });
    await this.indexQueue;
  }
}

function extractThreadIds(entry: LogEntry): string[] {
  const ids = new Set<string>();
  const payload = entry.payload;
  if (entry.threadId) {
    ids.add(entry.threadId);
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, JsonValue>;
    if (Array.isArray(record.threadIds)) {
      for (const id of record.threadIds) {
        if (typeof id === "string") {
          ids.add(id);
        }
      }
    }
    collectThreadIds(record.params, ids);
    collectThreadIds(record.result, ids);
  }
  return [...ids];
}

function threadIdsFromJson(value: JsonValue | undefined): string[] {
  const ids = new Set<string>();
  collectThreadIdsDeep(value, ids, 0);
  return [...ids];
}

function collectThreadIdsDeep(value: JsonValue | undefined, ids: Set<string>, depth: number): void {
  if (!value || typeof value !== "object" || depth > 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectThreadIdsDeep(item, ids, depth + 1);
    }
    return;
  }
  const record = value as Record<string, JsonValue>;
  if (typeof record.threadId === "string") {
    ids.add(record.threadId);
  }
  if (isThreadRecord(record.thread)) {
    ids.add(record.thread.id);
  }
  for (const nested of Object.values(record)) {
    collectThreadIdsDeep(nested, ids, depth + 1);
  }
}

function summarizeRpcPayload(value: JsonValue | undefined): JsonValue {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: summarizeArraySample(value)
    };
  }
  const record = value as Record<string, JsonValue>;
  if (isThreadRecord(record.thread)) {
    return {
      type: "object",
      keys: Object.keys(record),
      thread: summarizeThreadRecord(record.thread)
    };
  }
  if (Array.isArray(record.data)) {
    return {
      type: "object",
      keys: Object.keys(record),
      data: {
        type: "array",
        length: record.data.length,
        sample: summarizeArraySample(record.data)
      }
    };
  }
  return {
    type: "object",
    keys: Object.keys(record).slice(0, 30),
    threadId: typeof record.threadId === "string" ? record.threadId : null
  };
}

function summarizeArraySample(items: JsonValue[]): JsonValue[] {
  return items.slice(0, 5).map((item) => {
    if (isThreadRecord(item)) {
      return summarizeThreadRecord(item);
    }
    if (!item || typeof item !== "object") {
      return item;
    }
    if (Array.isArray(item)) {
      return { type: "array", length: item.length };
    }
    return { type: "object", keys: Object.keys(item).slice(0, 20) };
  });
}

function summarizeThreadRecord(thread: ThreadRecord): JsonValue {
  return {
    id: thread.id,
    name: typeof thread.name === "string" ? thread.name : null,
    preview: typeof thread.preview === "string" ? thread.preview : "",
    cwd: typeof thread.cwd === "string" ? thread.cwd : "",
    sessionId: typeof thread.sessionId === "string" ? thread.sessionId : "",
    createdAt: typeof thread.createdAt === "number" ? thread.createdAt : null,
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : null,
    status: thread.status ?? null,
    turnCount: Array.isArray(thread.turns) ? thread.turns.length : null
  };
}

function collectThreadIds(value: JsonValue | undefined, ids: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, JsonValue>;
  if (typeof record.threadId === "string") {
    ids.add(record.threadId);
  }
  if (isThreadRecord(record.thread)) {
    ids.add(record.thread.id);
  }
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      if (isThreadRecord(item)) {
        ids.add(item.id);
      }
    }
  }
}

function isThreadRecord(value: unknown): value is ThreadRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string");
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function jsonOrNull(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
