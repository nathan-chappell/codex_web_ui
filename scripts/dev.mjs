import { spawn } from "node:child_process";
import path from "node:path";

const appServerSocket = process.env.CODEX_APP_SERVER_SOCKET || path.join(process.cwd(), "tmp", "codex-app-server.sock");
const services = [
  { name: "app-server", args: ["run", "codex:app-server"], restartDelayMs: 2500, env: { CODEX_APP_SERVER_SOCKET: appServerSocket } },
  { name: "api", args: ["run", "dev:api"], restartDelayMs: 1000, env: { CODEX_APP_SERVER_SOCKET: appServerSocket } },
  { name: "client", args: ["run", "dev:client"], restartDelayMs: 1000 }
];

let shuttingDown = false;
const children = new Map();
const restartTimers = new Set();

for (const service of services) {
  startService(service);
}

function startService(service) {
  const child = spawn("npm", service.args, {
    stdio: "inherit",
    env: { ...process.env, ...service.env }
  });
  children.set(service.name, child);

  child.on("exit", (code, signal) => {
    children.delete(service.name);
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[dev] ${service.name} exited with ${reason}; restarting in ${service.restartDelayMs}ms`);
    const timer = setTimeout(() => {
      restartTimers.delete(timer);
      if (!shuttingDown) {
        startService(service);
      }
    }, service.restartDelayMs);
    restartTimers.add(timer);
  });
}

process.on("SIGINT", () => {
  shuttingDown = true;
  stopChildren();
  setTimeout(() => process.exit(0), 100);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  stopChildren();
  setTimeout(() => process.exit(0), 100);
});

function stopChildren() {
  for (const timer of restartTimers) {
    clearTimeout(timer);
  }
  restartTimers.clear();

  for (const child of children.values()) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  children.clear();
}
