import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import readline from "node:readline";
import type { EventHub } from "./eventHub";
import type { SessionLogStore } from "./logStore";
import type { JsonRpcNotification, JsonRpcResponse, JsonValue, ServerStatus } from "./types";

interface PendingRequest {
  method: string;
  resolve: (value: JsonValue | undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ClientRequest {
  id: string | number;
  method: string;
  params: JsonValue;
  receivedAt: number;
}

interface AppServerConnection {
  readonly pid: number | null;
  close(): Promise<void>;
  isWritable(): boolean;
  write(message: Record<string, unknown>): void;
}

export interface CodexBridgeConfig {
  command: string;
  cwd: string;
  model: string;
  reasoningEffort: string;
  fastMode: boolean;
  appServerSocketPath: string;
}

export class CodexBridge {
  private connection: AppServerConnection | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly clientRequests = new Map<string, ClientRequest>();
  private startPromise: Promise<void> | null = null;
  private readonly stderrLines: { at: number; line: string }[] = [];
  private status: ServerStatus;

  constructor(
    private readonly config: CodexBridgeConfig,
    private readonly hub: EventHub,
    private readonly logs: SessionLogStore
  ) {
    this.status = {
      state: "stopped",
      command: config.command,
      cwd: config.cwd,
      pid: null,
      startedAt: null,
      exitedAt: null,
      exitCode: null,
      signal: null,
      error: null
    };
  }

  summary(): Record<string, unknown> {
    return {
      ...this.status,
      stderr: [...this.stderrLines],
      config: this.config
    };
  }

  async start(): Promise<void> {
    if (this.connection && this.status.state === "running") {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startFresh();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    if (!this.connection) {
      return;
    }
    await this.connection.close();
  }

  async request(method: string, params: JsonValue = {}, options: { skipStart?: boolean; timeoutMs?: number } = {}): Promise<JsonValue | undefined> {
    try {
      return await this.requestOnce(method, params, options);
    } catch (error) {
      if (options.skipStart || !isRecoverableConnectionError(error)) {
        throw error;
      }
      this.connection = null;
      await delay(350);
      return this.requestOnce(method, params, options);
    }
  }

  private async requestOnce(method: string, params: JsonValue = {}, options: { skipStart?: boolean; timeoutMs?: number } = {}): Promise<JsonValue | undefined> {
    if (!options.skipStart) {
      await this.start();
    }
    if (!this.connection?.isWritable()) {
      throw new Error("codex app-server is not running");
    }

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const message = { id, method, params };
    void this.logs.recordRpcRequest(method, id, params);

    return new Promise<JsonValue | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve, reject, timer });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: JsonValue): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  pendingClientRequests(): ClientRequest[] {
    return [...this.clientRequests.values()].sort((a, b) => a.receivedAt - b.receivedAt);
  }

  respondClientRequest(id: string | number, result: JsonValue): void {
    const key = String(id);
    const request = this.clientRequests.get(key);
    if (!request) {
      throw new Error("Client request is not pending");
    }
    this.clientRequests.delete(key);
    this.write({
      jsonrpc: "2.0",
      id: request.id,
      result
    });
    this.hub.broadcast("client-request-resolved", { id: request.id, method: request.method, result });
  }

  private async startFresh(): Promise<void> {
    this.setStatus({
      state: "starting",
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
      signal: null,
      error: null
    });

    try {
      const connection = this.config.appServerSocketPath
        ? await this.connectUnixSocketAppServer()
        : this.spawnOwnedAppServer();
      this.connection = connection;
      this.setStatus({ state: "starting", pid: connection.pid });

      await this.request(
        "initialize",
        {
          clientInfo: { name: "codex-web-ui", version: "0.1.0" },
          capabilities: { experimentalApi: true }
        },
        { skipStart: true, timeoutMs: 30_000 }
      );
      this.notify("initialized");
      this.setStatus({ state: "running" });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.connection = null;
      this.setStatus({ state: "error", pid: null, error: err.message });
      throw err;
    }
  }

  private spawnOwnedAppServer(): AppServerConnection {
    const proc = spawn(this.config.command, ["app-server", ...this.configArgs(), "--listen", "stdio://"], {
      cwd: this.config.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    proc.once("error", (error) => this.handleConnectionError(error));
    proc.once("exit", (code, signal) => this.handleConnectionExit(
      code === 0 ? null : `codex app-server exited with code ${code ?? "unknown"}`,
      code,
      signal as NodeJS.Signals | null
    ));
    readline.createInterface({ input: proc.stdout }).on("line", (line) => this.handleMessageText(line));
    readline.createInterface({ input: proc.stderr }).on("line", (line) => this.handleStderr(line));

    return {
      pid: proc.pid ?? null,
      close: async () => {
        if (proc.exitCode !== null || proc.killed) {
          return;
        }
        proc.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (proc.exitCode === null && !proc.killed) {
              proc.kill("SIGKILL");
            }
            resolve();
          }, 5_000);
          proc.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      isWritable: () => proc.stdin.writable,
      write: (message: Record<string, unknown>) => {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
      }
    };
  }

  private async connectUnixSocketAppServer(): Promise<AppServerConnection> {
    return UnixWebSocketConnection.connect({
      path: this.config.appServerSocketPath,
      onClose: () => this.handleConnectionExit("codex app-server socket closed", null, null),
      onError: (error) => this.handleConnectionError(error),
      onMessage: (text) => this.handleMessageText(text)
    });
  }

  private configArgs(): string[] {
    const args: string[] = [];
    if (this.config.model) {
      args.push("-c", `model="${this.config.model}"`);
    }
    if (this.config.reasoningEffort) {
      args.push("-c", `model_reasoning_effort="${this.config.reasoningEffort}"`);
    }
    if (!this.config.fastMode) {
      args.push("--disable", "fast_mode");
    }
    return args;
  }

  private write(message: Record<string, unknown>): void {
    if (!this.connection?.isWritable()) {
      throw new Error("codex app-server connection is unavailable");
    }
    this.connection.write(message);
  }

  private handleMessageText(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      void this.logs.append({ type: "stdout", payload: line });
      this.hub.broadcast("stdout", { line });
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.hub.broadcast("json", parsed);
      return;
    }

    const message = parsed as JsonRpcResponse & JsonRpcNotification;
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const id = String(message.id);
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        void this.logs.recordRpcResponse(pending.method, message.id, message.result, message.error as JsonValue | undefined);
        this.hub.broadcast("rpc-response", { method: pending.method, id: message.id, ok: !message.error });
        if (message.error) {
          const error = new Error(message.error.message);
          (error as Error & { data?: unknown }).data = message.error;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (message.method) {
        const request = {
          id: message.id as string | number,
          method: message.method,
          params: (message.params ?? {}) as JsonValue,
          receivedAt: Date.now()
        };
        this.clientRequests.set(String(message.id), request);
        void this.logs.append({ type: "client-request", id: message.id, method: message.method, payload: message.params });
        this.hub.broadcast("client-request", request);
        return;
      }
    }

    if (message.method) {
      void this.logs.recordNotification(message.method, message.params);
      this.hub.broadcast("notification", message);
      return;
    }

    this.hub.broadcast("json", message);
  }

  private handleStderr(line: string): void {
    const item = { at: Date.now(), line };
    this.stderrLines.push(item);
    if (this.stderrLines.length > 150) {
      this.stderrLines.splice(0, this.stderrLines.length - 150);
    }
    void this.logs.append({ type: "stderr", payload: line });
    this.hub.broadcast("stderr", item);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setStatus(patch: Partial<ServerStatus>): void {
    this.status = { ...this.status, ...patch };
    this.hub.broadcast("server-status", this.summary());
    void this.logs.append({ type: "server", payload: this.summary() as JsonValue });
  }

  private handleConnectionError(error: Error): void {
    this.connection = null;
    this.setStatus({ state: "error", error: error.message });
    this.rejectPending(error);
    for (const request of this.clientRequests.values()) {
      this.hub.broadcast("client-request-resolved", { id: request.id, method: request.method, error: error.message });
    }
    this.clientRequests.clear();
  }

  private handleConnectionExit(error: string | null, code: number | null, signal: NodeJS.Signals | null): void {
    this.setStatus({
      state: "exited",
      pid: null,
      exitedAt: new Date().toISOString(),
      exitCode: code,
      signal,
      error
    });
    this.connection = null;
    this.rejectPending(new Error(error ?? "codex app-server exited"));
    for (const request of this.clientRequests.values()) {
      this.hub.broadcast("client-request-resolved", { id: request.id, method: request.method, error: error ?? "codex app-server exited" });
    }
    this.clientRequests.clear();
  }
}

function isRecoverableConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOENT|ECONNREFUSED|EPIPE|socket closed|connection is unavailable|app-server is not running)\b/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class UnixWebSocketConnection implements AppServerConnection {
  readonly pid = null;
  private closed = false;
  private closeSent = false;
  private buffer = Buffer.alloc(0);
  private fragmentedText = "";

  private constructor(
    private readonly socket: net.Socket,
    private readonly handlers: {
      onClose: () => void;
      onError: (error: Error) => void;
      onMessage: (text: string) => void;
    }
  ) {}

  static connect(options: {
    path: string;
    onClose: () => void;
    onError: (error: Error) => void;
    onMessage: (text: string) => void;
  }): Promise<UnixWebSocketConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(options.path);
      const key = crypto.randomBytes(16).toString("base64");
      const expectedAccept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      let handshakeBuffer = Buffer.alloc(0);
      let settled = false;
      let connection: UnixWebSocketConnection | null = null;

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(error);
          return;
        }
        options.onError(error);
      };

      socket.once("connect", () => {
        socket.write([
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          ""
        ].join("\r\n"));
      });

      socket.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (settled) {
          connection?.receive(buffer);
          return;
        }
        handshakeBuffer = Buffer.concat([handshakeBuffer, buffer]);
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const headerText = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
        const headers = parseHttpHeaders(headerText);
        if (!headerText.startsWith("HTTP/1.1 101") || headers["sec-websocket-accept"] !== expectedAccept) {
          fail(new Error("Codex app-server Unix socket did not accept WebSocket upgrade"));
          return;
        }
        settled = true;
        connection = new UnixWebSocketConnection(socket, options);
        resolve(connection);
        const remaining = handshakeBuffer.subarray(headerEnd + 4);
        if (remaining.length > 0) {
          connection.receive(remaining);
        }
      });

      socket.once("error", fail);
      socket.once("close", () => {
        if (!settled) {
          fail(new Error("Codex app-server Unix socket closed before WebSocket upgrade"));
          return;
        }
        connection?.markClosed();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.sendFrame(0x8, Buffer.alloc(0));
    this.closeSent = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        resolve();
      }, 1_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  isWritable(): boolean {
    return !this.closed && this.socket.writable;
  }

  write(message: Record<string, unknown>): void {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  }

  private parseFrames(): void {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const bigLength = this.buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.handlers.onError(new Error("Codex app-server WebSocket frame is too large"));
          this.socket.destroy();
          return;
        }
        length = Number(bigLength);
        offset = 10;
      }

      let mask: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        const unmasked = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }

      if (opcode === 0x8) {
        if (!this.closeSent) {
          this.sendFrame(0x8, Buffer.alloc(0));
        }
        this.socket.end();
        continue;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) {
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x0) {
        continue;
      }

      this.fragmentedText += payload.toString("utf8");
      if (fin) {
        const text = this.fragmentedText;
        this.fragmentedText = "";
        this.handlers.onMessage(text);
      }
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    const header = makeClientFrameHeader(opcode, payload.length);
    const mask = crypto.randomBytes(4);
    const maskedPayload = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      maskedPayload[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  private markClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.handlers.onClose();
  }
}

function makeClientFrameHeader(opcode: number, length: number): Buffer {
  if (length < 126) {
    return Buffer.from([0x80 | opcode, 0x80 | length]);
  }
  if (length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function parseHttpHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerText.split("\r\n").slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}
