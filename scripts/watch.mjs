import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const appServerSocket = process.env.CODEX_APP_SERVER_SOCKET || path.join(projectRoot, "tmp", "codex-app-server.sock");
const ignoredDirs = new Set([".git", ".agents", ".codex", "data", "dist", "node_modules", "tmp"]);
const watchers = [];
const restartTimers = new Set();
const tasks = new Map();

let appServer = null;
let backend = null;
let shuttingDown = false;
let restartingBackend = false;

await run("client build", ["run", "build:client"]);
await run("server build", ["run", "build:server"]);

startAppServer();
startBackend();
watchTree(path.join(projectRoot, "client"), () => scheduleTask("client", rebuildClient));
watchTree(path.join(projectRoot, "app"), () => scheduleTask("client", rebuildClient));
watchTree(path.join(projectRoot, "components"), () => scheduleTask("client", rebuildClient));
watchTree(path.join(projectRoot, "lib"), () => scheduleTask("client", rebuildClient));
watchTree(path.join(projectRoot, "server"), () => scheduleTask("server", rebuildServerAndRestartBackend));
watchFile(path.join(projectRoot, "next.config.ts"), () => scheduleTask("client", rebuildClient));
watchFile(path.join(projectRoot, "postcss.config.mjs"), () => scheduleTask("client", rebuildClient));
watchFile(path.join(projectRoot, "components.json"), () => scheduleTask("client", rebuildClient));
watchFile(path.join(projectRoot, "tsconfig.server.json"), () => scheduleTask("server", rebuildServerAndRestartBackend));
watchFile(path.join(projectRoot, "package.json"), () => {
  scheduleTask("client", rebuildClient);
  scheduleTask("server", rebuildServerAndRestartBackend);
});

console.log("[watch] serving rebuilt frontend from dist/public");
console.log("[watch] backend restarts on server changes");
console.log(`[watch] backend connects through codex app-server socket ${appServerSocket}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    stopAll();
    setTimeout(() => process.exit(0), 100);
  });
}

async function rebuildClient() {
  await run("client build", ["run", "build:client"]);
}

async function rebuildServerAndRestartBackend() {
  await run("server build", ["run", "build:server"]);
  await restartBackend();
}

function scheduleTask(key, task) {
  const state = tasks.get(key) || { timer: null, running: false, pending: false };
  state.pending = true;
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    void drainTask(key, task);
  }, 250);
  tasks.set(key, state);
}

async function drainTask(key, task) {
  const state = tasks.get(key);
  if (!state || state.running) {
    return;
  }

  state.running = true;
  while (state.pending && !shuttingDown) {
    state.pending = false;
    try {
      await task();
    } catch (error) {
      console.error(`[watch] ${key} task failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  state.running = false;
}

function startAppServer() {
  appServer = spawn("npm", ["run", "codex:app-server"], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_APP_SERVER_SOCKET: appServerSocket },
    stdio: "inherit"
  });

  appServer.on("exit", (code, signal) => {
    appServer = null;
    if (shuttingDown) {
      return;
    }
    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[watch] codex app-server exited with ${reason}; restarting in 2500ms`);
    scheduleRestart(startAppServer, 2500);
  });
}

function startBackend() {
  backend = spawn("node", ["dist/server/index.js"], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_APP_SERVER_SOCKET: appServerSocket },
    stdio: "inherit"
  });

  backend.on("exit", (code, signal) => {
    backend = null;
    if (shuttingDown || restartingBackend) {
      return;
    }
    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[watch] backend exited with ${reason}; restarting in 1000ms`);
    scheduleRestart(startBackend, 1000);
  });
}

async function restartBackend() {
  if (restartingBackend) {
    return;
  }
  restartingBackend = true;
  try {
    await stopChild(backend);
    backend = null;
    if (!shuttingDown) {
      startBackend();
    }
  } finally {
    restartingBackend = false;
  }
}

function scheduleRestart(callback, delayMs) {
  const timer = setTimeout(() => {
    restartTimers.delete(timer);
    if (!shuttingDown) {
      callback();
    }
  }, delayMs);
  restartTimers.add(timer);
}

function run(label, args) {
  return new Promise((resolve, reject) => {
    console.log(`[watch] ${label}`);
    const child = spawn("npm", args, { cwd: projectRoot, env: process.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`));
    });
  });
}

function watchTree(root, callback) {
  if (!existsSync(root)) {
    return;
  }
  for (const dir of listDirs(root)) {
    const watcher = watch(dir, { persistent: true }, () => {
      callback();
      refreshTree(root, callback);
    });
    watchers.push(watcher);
  }
}

function refreshTree(root, callback) {
  for (const watcher of watchers.splice(0)) {
    watcher.close();
  }
  watchTree(path.join(projectRoot, "client"), () => scheduleTask("client", rebuildClient));
  watchTree(path.join(projectRoot, "app"), () => scheduleTask("client", rebuildClient));
  watchTree(path.join(projectRoot, "components"), () => scheduleTask("client", rebuildClient));
  watchTree(path.join(projectRoot, "lib"), () => scheduleTask("client", rebuildClient));
  watchTree(path.join(projectRoot, "server"), () => scheduleTask("server", rebuildServerAndRestartBackend));
  watchFile(path.join(projectRoot, "next.config.ts"), () => scheduleTask("client", rebuildClient));
  watchFile(path.join(projectRoot, "postcss.config.mjs"), () => scheduleTask("client", rebuildClient));
  watchFile(path.join(projectRoot, "components.json"), () => scheduleTask("client", rebuildClient));
  watchFile(path.join(projectRoot, "tsconfig.server.json"), () => scheduleTask("server", rebuildServerAndRestartBackend));
  watchFile(path.join(projectRoot, "package.json"), () => {
    scheduleTask("client", rebuildClient);
    scheduleTask("server", rebuildServerAndRestartBackend);
  });
}

function watchFile(filePath, callback) {
  if (!existsSync(filePath)) {
    return;
  }
  watchers.push(watch(filePath, { persistent: true }, callback));
}

function listDirs(root) {
  const dirs = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || ignoredDirs.has(entry.name)) {
      continue;
    }
    const child = path.join(root, entry.name);
    try {
      if (statSync(child).isDirectory()) {
        dirs.push(...listDirs(child));
      }
    } catch {
      // Directory changed while refreshing watchers.
    }
  }
  return dirs;
}

function stopAll() {
  for (const timer of restartTimers) {
    clearTimeout(timer);
  }
  restartTimers.clear();
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers.length = 0;
  void stopChild(backend);
  void stopChild(appServer);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
