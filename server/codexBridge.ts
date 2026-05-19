import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { EventHub } from "./eventHub.js";
import type { SessionLogStore } from "./logStore.js";
import type { JsonRpcNotification, JsonRpcResponse, JsonValue, ServerStatus } from "./types.js";

interface PendingRequest {
  method: string;
  resolve: (value: JsonValue | undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
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
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
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
    if (this.proc && this.status.state === "running") {
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
    if (!this.proc) {
      return;
    }
    const proc = this.proc;
    if (proc.exitCode === null && !proc.killed) {
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
    }
  }

  async request(method: string, params: JsonValue = {}, options: { skipStart?: boolean; timeoutMs?: number } = {}): Promise<JsonValue | undefined> {
    if (!options.skipStart) {
      await this.start();
    }
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("codex app-server is not running");
    }

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const message = { jsonrpc: "2.0" as const, id, method, params };
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
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
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

    const proc = this.config.appServerSocketPath
      ? this.spawnProxy()
      : this.spawnOwnedAppServer();
    this.proc = proc;
    this.setStatus({ state: "starting", pid: proc.pid ?? null });

    proc.once("error", (error) => {
      this.setStatus({ state: "error", error: error.message });
      this.rejectPending(error);
    });
    proc.once("exit", (code, signal) => {
      this.setStatus({
        state: "exited",
        pid: null,
        exitedAt: new Date().toISOString(),
        exitCode: code,
        signal,
        error: code === 0 ? null : `${this.config.appServerSocketPath ? "codex app-server proxy" : "codex app-server"} exited with code ${code ?? "unknown"}`
      });
      this.proc = null;
      this.rejectPending(new Error(this.status.error ?? "codex app-server exited"));
    });

    readline.createInterface({ input: proc.stdout }).on("line", (line) => this.handleStdout(line));
    readline.createInterface({ input: proc.stderr }).on("line", (line) => this.handleStderr(line));

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
  }

  private spawnOwnedAppServer(): ChildProcessWithoutNullStreams {
    return spawn(this.config.command, ["app-server", ...this.configArgs(), "--listen", "stdio://"], {
      cwd: this.config.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
  }

  private spawnProxy(): ChildProcessWithoutNullStreams {
    return spawn(this.config.command, ["app-server", "proxy", "--sock", this.config.appServerSocketPath], {
      cwd: this.config.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
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
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("codex app-server stdin is unavailable");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(line: string): void {
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
        void this.logs.append({ type: "client-request", id: message.id, method: message.method, payload: message.params });
        this.hub.broadcast("client-request", message);
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Client-side JSON-RPC requests are not implemented by this web UI" }
        });
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
}
