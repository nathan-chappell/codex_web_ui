import { spawn } from "node:child_process";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const socketPath = process.env.CODEX_APP_SERVER_SOCKET || path.join(projectRoot, "tmp", "codex-app-server.sock");
const command = process.env.CODEX_COMMAND || "codex";
const cwd = process.env.CODEX_CWD || projectRoot;

mkdirSync(path.dirname(socketPath), { recursive: true });
removeStaleSocket(socketPath);

const args = ["app-server", ...configArgs(), "--listen", `unix://${socketPath}`];
const child = spawn(command, args, {
  cwd,
  env: process.env,
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

function configArgs() {
  const args = [];
  if (process.env.CODEX_MODEL) {
    args.push("-c", `model="${process.env.CODEX_MODEL}"`);
  }
  if (process.env.CODEX_REASONING_EFFORT) {
    args.push("-c", `model_reasoning_effort="${process.env.CODEX_REASONING_EFFORT}"`);
  }
  if (process.env.CODEX_FAST_MODE === "0") {
    args.push("--disable", "fast_mode");
  }
  return args;
}

function removeStaleSocket(filePath) {
  try {
    const stat = statSync(filePath);
    if (stat.isSocket()) {
      unlinkSync(filePath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}
