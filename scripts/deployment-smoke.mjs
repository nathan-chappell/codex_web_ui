#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const npmSpec = process.env.CODEX_WEB_UI_DEPLOYMENT_NPM_SPEC || `${packageJson.name}@${packageJson.version}`;
const host = process.env.CODEX_WEB_UI_DEPLOYMENT_HOST || "0.0.0.0";
const port = Number(process.env.CODEX_WEB_UI_DEPLOYMENT_PORT || "4546");
const password = process.env.CODEX_WEB_UI_DEPLOYMENT_PASSWORD || "codex";
const authSecret = process.env.CODEX_WEB_UI_DEPLOYMENT_AUTH_SECRET || "deployment-smoke-auth-secret";
const keep = truthy(process.env.CODEX_WEB_UI_DEPLOYMENT_KEEP);

const installDir = await mkdtemp(path.join(tmpdir(), "codex-web-ui-deploy-install-"));
const runDir = await mkdtemp(path.join(tmpdir(), "codex-web-ui-deploy-run-"));
const dataDir = path.join(runDir, "data");
const uploadDir = path.join(dataDir, "uploads");
const socketPath = path.join(runDir, "codex-app-server.sock");
const logPath = path.join(runDir, "server.log");
let server = null;
let binPath = "";

try {
  await command("npm", ["init", "-y"], { cwd: installDir, quiet: true, label: "initializing temp package" });
  await command("npm", ["install", npmSpec], { cwd: installDir, label: `installing ${npmSpec}` });

  binPath = path.join(installDir, "node_modules", ".bin", "codex-web-ui");
  await command(binPath, ["app-server", "start", "--socket", socketPath], {
    cwd: installDir,
    env: cleanEnv({}),
    label: "starting fresh codex app-server"
  });

  await writeFile(logPath, "");
  server = spawn(binPath, [
    "--host", host,
    "--port", String(port),
    "--cwd", installDir,
    "--data-dir", dataDir,
    "--upload-dir", uploadDir,
    "--app-server-socket", socketPath,
    "--approval-policy", "on-request",
    "--sandbox", "workspace-write"
  ], {
    cwd: installDir,
    detached: true,
    env: cleanEnv({
      CODEX_WEB_UI_PASSWORD: password,
      CODEX_WEB_UI_AUTH_SECRET: authSecret
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => appendLog(logPath, chunk));
  server.stderr.on("data", (chunk) => appendLog(logPath, chunk));
  server.unref();

  await waitForHttp(`http://127.0.0.1:${port}/api/auth`, logPath);
  const auth = await json(`http://127.0.0.1:${port}/api/auth`);
  const policy = auth.permissionPolicy ?? {};
  if (auth.ok !== true || auth.authenticated !== false || auth.mode !== "password") {
    throw new Error(`Unexpected /api/auth response: ${JSON.stringify(auth)}`);
  }
  if (policy.defaultApprovalPolicy !== "on-request" || policy.defaultSandbox !== "workspace-write") {
    throw new Error(`Unexpected permission policy: ${JSON.stringify(policy)}`);
  }

  const login = await json(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  if (typeof login.token !== "string" || !login.authenticated) {
    throw new Error("Deployment login smoke failed");
  }

  console.log(`Deployment smoke passed for ${npmSpec} on http://${host}:${port}`);
  if (keep) {
    console.log(`Install dir: ${installDir}`);
    console.log(`Run dir: ${runDir}`);
    console.log(`Password: ${password}`);
  }
} finally {
  if (!keep) {
    await stopServer(server, binPath, socketPath);
    await rm(installDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
}

async function waitForHttp(url, logPath) {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  const log = await readFile(logPath, "utf8").catch(() => "");
  throw new Error(`${lastError?.message || `Timed out waiting for ${url}`}\n${log}`);
}

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function stopServer(server, binPath, socketPath) {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Process may have already exited.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // Process may have already exited.
    }
  }
  if (binPath) {
    await command(binPath, ["app-server", "stop", "--socket", socketPath], { allowFailure: true, quiet: true });
  }
  await command("pkill", ["-f", socketPath], { allowFailure: true, quiet: true });
}

function command(binary, args, options = {}) {
  if (!options.quiet) {
    console.log(`${options.label || binary}: ${binary} ${args.join(" ")}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: options.quiet ? "ignore" : "inherit"
    });
    child.once("error", (error) => {
      if (options.allowFailure) resolve();
      else reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || options.allowFailure) {
        resolve();
      } else {
        reject(new Error(`${binary} exited with ${signal || code}`));
      }
    });
  });
}

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "CODEX_WEB_UI_FULL_CONTROL",
    "CODEX_WEB_UI_PERMISSION_PRESET",
    "CODEX_WEB_UI_APPROVAL_POLICY",
    "CODEX_WEB_UI_SANDBOX",
    "CODEX_WEB_UI_LOCK_PERMISSIONS",
    "CODEX_WEB_UI_UNSAFE_PERMISSIONS"
  ]) {
    delete env[key];
  }
  return env;
}

function appendLog(logPath, chunk) {
  void appendFile(logPath, chunk);
}

function truthy(value) {
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
