#!/usr/bin/env node

import { spawn } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseArgs as parseNodeArgs } from "node:util";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launchCwd = process.cwd();
const userConfigDir = join(homedir(), ".codex-webgui");
const defaultConfigPath = join(userConfigDir, "config.json");
const defaultAppServerSocket = join(userConfigDir, "codex-app-server.sock");
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const rawArgs = process.argv.slice(2);

if (rawArgs[0] === "app-server") {
  await runAppServerCommand(parseAppServerArgs(rawArgs.slice(1)));
  process.exit(0);
}

if (rawArgs[0] === "init") {
  await runInitCommand(parseInitArgs(rawArgs.slice(1)));
  process.exit(0);
}

const command = rawArgs[0] === "doctor" ? "doctor" : "start";
const commandArgs = command === "doctor" ? rawArgs.slice(1) : rawArgs;
const options = parseArgs(commandArgs);

if (options.help) {
  command === "doctor" ? printDoctorHelp() : printHelp();
  process.exit(0);
}

const configPath = resolveConfigPath(options.config);
const config = configPath ? readConfig(configPath) : {};
const env = { ...process.env };
const host = pick("host", "HOST", "127.0.0.1");
const port = String(pick("port", "PORT", "4545"));
const dataDir = resolvePath(pick("dataDir", "CODEX_WEB_UI_DATA_DIR", join(userConfigDir, "data")));
const uploadDir = resolvePath(pick("uploadDir", "CODEX_WEB_UI_UPLOAD_DIR", join(dataDir, "uploads")));
const codexCwd = resolvePath(pick("cwd", "CODEX_CWD", launchCwd));
const codexCommand = pick("codexCommand", "CODEX_COMMAND", "codex");
const appServerSocket = resolvePath(pick("appServerSocket", "CODEX_APP_SERVER_SOCKET", defaultAppServerSocket));
const externalAppServer = pickBoolean("externalAppServer", "CODEX_WEB_UI_EXTERNAL_APP_SERVER", false);
const requestedSandbox = pick("sandbox", "CODEX_WEB_UI_SANDBOX", "workspace-write");
const fullControl = pickBoolean("fullControl", "CODEX_WEB_UI_FULL_CONTROL", false) || requestedSandbox === "full-control" || pick("permissionPreset", "CODEX_WEB_UI_PERMISSION_PRESET") === "full-control";
const unsafePermissions = fullControl || pickBoolean("unsafePermissions", "CODEX_WEB_UI_UNSAFE_PERMISSIONS", false);
const approvalPolicy = pick("approvalPolicy", "CODEX_WEB_UI_APPROVAL_POLICY", fullControl ? "never" : "on-request");
const sandbox = fullControl ? "danger-full-access" : requestedSandbox;
let password = pick("password", "CODEX_WEB_UI_PASSWORD");
let generatedPassword = "";
const permissionsSpecified = hasPermissionConfig(options) || hasPermissionConfig(config) || Boolean(
  env.CODEX_WEB_UI_APPROVAL_POLICY
  || env.CODEX_WEB_UI_SANDBOX
  || env.CODEX_WEB_UI_FULL_CONTROL
  || env.CODEX_WEB_UI_PERMISSION_PRESET
  || env.CODEX_WEB_UI_LOCK_PERMISSIONS
);

if (command === "doctor") {
  await runDoctorCommand({
    appServerSocket,
    approvalPolicy,
    codexCommand,
    codexCwd,
    configPath,
    dataDir,
    externalAppServer,
    fullControl,
    host,
    packageRoot,
    password,
    port,
    sandbox,
    unsafePermissions,
    uploadDir
  });
  process.exit(process.exitCode ?? 0);
}

if (!password && isLoopbackHost(host)) {
  generatedPassword = randomSecret(18);
  password = generatedPassword;
}

setEnv(env, "HOST", host);
setEnv(env, "PORT", port);
setEnv(env, "CODEX_WEB_UI_PASSWORD", password);
setEnv(env, "CODEX_WEB_UI_AUTH_SECRET", pick("authSecret", "CODEX_WEB_UI_AUTH_SECRET"));
setEnv(env, "CODEX_WEB_UI_ALLOWED_ORIGINS", pick("allowedOrigins", "CODEX_WEB_UI_ALLOWED_ORIGINS"));
setEnv(env, "CODEX_WEB_UI_DATA_DIR", dataDir);
setEnv(env, "CODEX_WEB_UI_UPLOAD_DIR", uploadDir);
setEnv(env, "CODEX_APP_SERVER_SOCKET", appServerSocket);
setEnv(env, "CODEX_COMMAND", codexCommand);
setEnv(env, "CODEX_CWD", codexCwd);
setEnv(env, "CODEX_MODEL", pick("model", "CODEX_MODEL"));
setEnv(env, "CODEX_REASONING_EFFORT", pick("reasoningEffort", "CODEX_REASONING_EFFORT"));
setEnv(env, "CODEX_WEB_UI_APPROVAL_POLICY", approvalPolicy);
setEnv(env, "CODEX_WEB_UI_SANDBOX", sandbox);
setEnv(env, "CODEX_WEB_UI_UNSAFE_PERMISSIONS", unsafePermissions ? "1" : "0");
setEnv(env, "CODEX_WEB_UI_LOCK_PERMISSIONS", permissionsSpecified ? "1" : "0");

validatePort(port);
validatePermissionOptions({ approvalPolicy, sandbox, unsafePermissions });
validateSafety({ host, password: env.CODEX_WEB_UI_PASSWORD, allowPublicWithoutPassword: pickBoolean("allowPublicWithoutPassword", undefined, false) });

if (pickBoolean("build", undefined, false)) {
  await runNext(["build"], env);
}

if (!existsSync(join(packageRoot, ".next", "BUILD_ID"))) {
  fail("No Next production build found. Run `codex-web-ui --build` once, or install a package that includes the built app.");
}

mkdirSync(dataDir, { recursive: true });
mkdirSync(uploadDir, { recursive: true });

if (!externalAppServer) {
  await recoverAppServer(appServerControlOptions({ command: codexCommand, socket: appServerSocket }));
}

console.log(`codex-web-ui listening on http://${host}:${port}`);
console.log(`codex-web-ui app cwd: ${packageRoot}`);
console.log(`codex default cwd: ${env.CODEX_CWD}`);
console.log(`runtime data dir: ${env.CODEX_WEB_UI_DATA_DIR}`);
console.log(`codex app-server socket: ${env.CODEX_APP_SERVER_SOCKET}${externalAppServer ? " (external)" : " (managed)"}`);
console.log(`permissions: approval=${env.CODEX_WEB_UI_APPROVAL_POLICY}, sandbox=${env.CODEX_WEB_UI_SANDBOX}${env.CODEX_WEB_UI_LOCK_PERMISSIONS === "1" ? ", locked" : ""}${unsafePermissions ? ", unsafe enabled" : ""}`);
if (configPath) {
  console.log(`config file: ${configPath}`);
}
if (generatedPassword) {
  console.warn(`temporary local login password: ${generatedPassword}`);
  console.warn("Set CODEX_WEB_UI_PASSWORD or run `codex-web-ui init` to keep a stable password.");
}

await runNext(["start", "--hostname", host, "--port", port], env);

function parseArgs(args) {
  try {
    const { values } = parseNodeArgs({
      args,
      allowPositionals: false,
      options: {
        "allow-public-without-password": { type: "boolean" },
        "allowed-origins": { type: "string" },
        "app-server-socket": { type: "string" },
        "auth-secret": { type: "string" },
        build: { type: "boolean" },
        config: { type: "string", short: "c" },
        "codex-command": { type: "string" },
        cwd: { type: "string" },
        "data-dir": { type: "string" },
        effort: { type: "string" },
        "external-app-server": { type: "boolean" },
        "full-control": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        host: { type: "string" },
        model: { type: "string" },
        password: { type: "string" },
        port: { type: "string" },
        "approval-policy": { type: "string" },
        "reasoning-effort": { type: "string" },
        sandbox: { type: "string" },
        "unsafe-permissions": { type: "boolean" },
        "upload-dir": { type: "string" }
      }
    });
    return {
      allowPublicWithoutPassword: values["allow-public-without-password"],
      allowedOrigins: values["allowed-origins"],
      appServerSocket: values["app-server-socket"],
      approvalPolicy: values["approval-policy"],
      authSecret: values["auth-secret"],
      build: values.build,
      codexCommand: values["codex-command"],
      config: values.config,
      cwd: values.cwd,
      dataDir: values["data-dir"],
      externalAppServer: values["external-app-server"],
      fullControl: values["full-control"],
      help: values.help,
      host: values.host,
      model: values.model,
      password: values.password,
      port: values.port,
      reasoningEffort: values["reasoning-effort"] ?? values.effort,
      sandbox: values.sandbox,
      unsafePermissions: values["unsafe-permissions"],
      uploadDir: values["upload-dir"]
    };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function parseInitArgs(args) {
  try {
    const { values } = parseNodeArgs({
      args,
      allowPositionals: false,
      options: {
        "allowed-origins": { type: "string" },
        "app-server-socket": { type: "string" },
        config: { type: "string", short: "c" },
        "codex-command": { type: "string" },
        cwd: { type: "string" },
        "data-dir": { type: "string" },
        effort: { type: "string" },
        force: { type: "boolean" },
        "full-control": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        host: { type: "string" },
        model: { type: "string" },
        password: { type: "string" },
        port: { type: "string" },
        "reasoning-effort": { type: "string" },
        "upload-dir": { type: "string" }
      }
    });
    return {
      allowedOrigins: values["allowed-origins"],
      appServerSocket: values["app-server-socket"],
      codexCommand: values["codex-command"],
      config: values.config,
      cwd: values.cwd,
      dataDir: values["data-dir"],
      force: values.force,
      fullControl: values["full-control"],
      help: values.help,
      host: values.host,
      model: values.model,
      password: values.password,
      port: values.port,
      reasoningEffort: values["reasoning-effort"] ?? values.effort,
      uploadDir: values["upload-dir"]
    };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function parseAppServerArgs(args) {
  try {
    const { positionals, values } = parseNodeArgs({
      args,
      allowPositionals: true,
      options: {
        "app-server-socket": { type: "string" },
        "codex-command": { type: "string" },
        help: { type: "boolean", short: "h" },
        "log-file": { type: "string" },
        "pid-file": { type: "string" },
        socket: { type: "string" }
      }
    });
    const socket = resolvePath(values.socket ?? values["app-server-socket"] ?? process.env.CODEX_APP_SERVER_SOCKET ?? defaultAppServerSocket);
    return {
      action: positionals[0] ?? (values.help ? "help" : "status"),
      command: values["codex-command"] ?? process.env.CODEX_COMMAND ?? "codex",
      help: values.help,
      ...appServerControlOptions({
        command: values["codex-command"] ?? process.env.CODEX_COMMAND ?? "codex",
        logFile: values["log-file"] ?? process.env.CODEX_APP_SERVER_LOG_FILE,
        pidFile: values["pid-file"] ?? process.env.CODEX_APP_SERVER_PID_FILE,
        socket
      }),
      socket
    };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function runInitCommand(options) {
  if (options.help) {
    printInitHelp();
    return;
  }
  const target = resolvePath(options.config ?? defaultConfigPath);
  if (existsSync(target) && !options.force) {
    fail(`Config already exists: ${target}. Use --force to overwrite it.`);
  }
  const dataDir = options.dataDir ?? "~/.codex-webgui/data";
  const config = cleanObject({
    host: options.host ?? "127.0.0.1",
    port: Number(options.port ?? 4545),
    password: options.password ?? randomSecret(18),
    appServerSocket: options.appServerSocket ?? "~/.codex-webgui/codex-app-server.sock",
    codexCommand: options.codexCommand ?? "codex",
    cwd: options.cwd ? resolvePath(options.cwd) : launchCwd,
    model: options.model ?? "gpt-5.5",
    reasoningEffort: options.reasoningEffort ?? "high",
    permissions: options.fullControl ? "full-control" : undefined,
    approvalPolicy: options.fullControl ? undefined : "on-request",
    sandbox: options.fullControl ? undefined : "workspace-write",
    unsafePermissions: options.fullControl ? undefined : false,
    dataDir,
    uploadDir: options.uploadDir ?? "~/.codex-webgui/data/uploads",
    allowedOrigins: options.allowedOrigins ?? "http://localhost:*,http://127.0.0.1:*"
  });
  validatePort(String(config.port));
  validateSafety({ host: String(config.host), password: String(config.password || ""), allowPublicWithoutPassword: false });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(target, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  mkdirSync(resolvePath(dataDir), { recursive: true });
  mkdirSync(resolvePath(String(config.uploadDir)), { recursive: true });

  console.log(`Wrote config: ${target}`);
  console.log(`Login password: ${config.password}`);
  console.log("");
  console.log("Next steps:");
  console.log("  codex-web-ui doctor");
  console.log("  codex-web-ui");
}

async function runAppServerCommand(options) {
  if (options.help || options.action === "help") {
    printAppServerHelp();
    return;
  }
  if (!["start", "stop", "restart", "recover", "status"].includes(options.action)) {
    fail(`Unknown app-server command: ${options.action}`);
  }
  if (options.action === "start") {
    await startAppServer(options);
    return;
  }
  if (options.action === "stop") {
    await stopAppServer(options);
    return;
  }
  if (options.action === "restart") {
    await stopAppServer(options, { quiet: true });
    await startAppServer(options);
    return;
  }
  if (options.action === "recover") {
    await recoverAppServer(options);
    return;
  }
  await printAppServerStatus(options);
}

async function runDoctorCommand(options) {
  const checks = [];
  checks.push(["config", options.configPath ? `found ${options.configPath}` : "not found; defaults will be used", true]);
  checks.push(["production build", join(options.packageRoot, ".next", "BUILD_ID"), existsSync(join(options.packageRoot, ".next", "BUILD_ID"))]);
  checks.push(["data dir", options.dataDir, ensureWritableDir(options.dataDir)]);
  checks.push(["upload dir", options.uploadDir, ensureWritableDir(options.uploadDir)]);
  checks.push(["codex cwd", options.codexCwd, existsSync(options.codexCwd)]);
  checks.push(["auth password", options.password ? "configured" : "not configured; start will generate a temporary loopback password", Boolean(options.password) || isLoopbackHost(options.host)]);
  checks.push(["host safety", `${options.host}:${options.port}`, isLoopbackHost(options.host) || Boolean(options.password)]);
  checks.push(["permissions", `approval=${options.approvalPolicy}, sandbox=${options.sandbox}${options.fullControl ? ", full-control" : ""}`, permissionOptionsAreValid(options)]);

  const codex = await checkCommand(options.codexCommand, ["--version"]);
  checks.push(["codex command", codex.detail, codex.ok]);
  if (codex.ok) {
    const login = await checkCommand(options.codexCommand, ["login", "status"]);
    checks.push(["codex login", login.detail, login.ok]);
  }

  const socketPresent = existsSync(options.appServerSocket);
  const socketConnectable = socketPresent ? await isSocketConnectable(options.appServerSocket, 500) : false;
  checks.push([
    "app-server socket",
    `${options.appServerSocket}${socketConnectable ? " (connectable)" : socketPresent ? " (present, not connectable)" : " (missing)"}`,
    options.externalAppServer ? socketConnectable : true
  ]);

  console.log("Codex Web UI doctor");
  for (const [name, detail, ok] of checks) {
    console.log(`${ok ? "ok  " : "fail"} ${name}: ${detail}`);
  }
  console.log("");
  if (!socketConnectable && !options.externalAppServer) {
    console.log("The main `codex-web-ui` command will try to start or recover the managed app-server sidecar.");
  }
  if (!options.password && isLoopbackHost(options.host)) {
    console.log("No password is configured; `codex-web-ui` will print a temporary local password on each start.");
    console.log("Run `codex-web-ui init` to create a stable config.");
  }
  const failed = checks.some(([, , ok]) => !ok);
  process.exitCode = failed ? 1 : 0;
}

function appServerControlOptions({ command, logFile, pidFile, socket }) {
  const resolvedSocket = resolvePath(socket);
  const runtimeDir = dirname(resolvedSocket);
  return {
    command,
    logFile: resolvePath(logFile ?? join(runtimeDir, "codex-app-server.log")),
    pidFile: resolvePath(pidFile ?? join(runtimeDir, "codex-app-server.pid")),
    socket: resolvedSocket
  };
}

async function startAppServer(options) {
  const existingPid = readPid(options.pidFile);
  if (existingPid && isPidRunning(existingPid)) {
    if (await isSocketConnectable(options.socket, 750)) {
      console.log(`codex app-server already running: pid=${existingPid}`);
      console.log(`socket: ${options.socket} (connectable)`);
      return;
    }
    console.warn(`codex app-server pid ${existingPid} is present, but the socket is not connectable; restarting`);
    await stopAppServer(options, { quiet: true });
  }
  mkdirSync(dirname(options.socket), { recursive: true });
  mkdirSync(dirname(options.pidFile), { recursive: true });
  mkdirSync(dirname(options.logFile), { recursive: true });
  if (existsSync(options.socket)) {
    rmSync(options.socket, { force: true });
  }
  const logFd = openSync(options.logFile, "a");
  const child = spawn(options.command, ["app-server", "--listen", `unix://${options.socket}`], {
    cwd: launchCwd,
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  closeSync(logFd);
  if (!child.pid) {
    fail("Failed to start codex app-server");
  }
  writeFileSync(options.pidFile, `${child.pid}\n`);
  const ready = await waitForSocket(options.socket, 5_000);
  if (!ready) {
    fail(`Timed out waiting for codex app-server socket: ${options.socket}. Check ${options.logFile}`);
  }
  console.log(`codex app-server started: pid=${child.pid}`);
  console.log(`socket: ${options.socket} (connectable)`);
  console.log(`log: ${options.logFile}`);
}

async function stopAppServer(options, { quiet = false } = {}) {
  const pid = readPid(options.pidFile);
  if (!pid || !isPidRunning(pid)) {
    if (existsSync(options.socket)) {
      rmSync(options.socket, { force: true });
    }
    if (!quiet) {
      console.log("codex app-server is not running");
    }
    return;
  }
  killAppServerPid(pid, "SIGTERM");
  await waitForPidExit(pid, 2500);
  if (isPidRunning(pid)) {
    killAppServerPid(pid, "SIGKILL");
    await waitForPidExit(pid, 1000);
  }
  if (existsSync(options.socket)) {
    rmSync(options.socket, { force: true });
  }
  if (!quiet) {
    console.log(`codex app-server stopped: pid=${pid}`);
  }
}

async function recoverAppServer(options) {
  const pid = readPid(options.pidFile);
  if (pid && isPidRunning(pid) && await isSocketConnectable(options.socket, 750)) {
    console.log(`codex app-server healthy: pid=${pid}`);
    console.log(`socket: ${options.socket} (connectable)`);
    return;
  }
  await stopAppServer(options, { quiet: true });
  await startAppServer(options);
  console.log("codex app-server recovered");
}

async function printAppServerStatus(options) {
  const pid = readPid(options.pidFile);
  const running = Boolean(pid && isPidRunning(pid));
  const socketPresent = existsSync(options.socket);
  const socketConnectable = socketPresent ? await isSocketConnectable(options.socket, 500) : false;
  const state = running && socketConnectable
    ? "running"
    : running
      ? "degraded"
      : socketPresent
        ? "stopped with stale socket"
        : "stopped";
  console.log(`codex app-server ${state}${pid ? `: pid=${pid}` : ""}`);
  console.log(`socket: ${options.socket}${socketConnectable ? " (connectable)" : socketPresent ? " (present, not connectable)" : " (missing)"}`);
  console.log(`pid file: ${options.pidFile}`);
  console.log(`log: ${options.logFile}`);
}

function readPid(pidFile) {
  if (!existsSync(pidFile)) {
    return null;
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killAppServerPid(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function waitForPidExit(pid, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!isPidRunning(pid) || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}

function waitForSocket(socket, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await isSocketConnectable(socket, 250)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 100);
    };
    void tick();
  });
}

function isSocketConnectable(socket, timeoutMs) {
  if (!existsSync(socket)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const client = createConnection(socket);
    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, timeoutMs);
    client.once("connect", () => {
      clearTimeout(timer);
      client.end();
      resolve(true);
    });
    client.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function setEnv(env, key, value) {
  if (value !== undefined) {
    env[key] = String(value);
  }
}

function pick(name, envKey, fallback) {
  return options[name] ?? (envKey ? env[envKey] : undefined) ?? config[name] ?? fallback;
}

function pickBoolean(name, envKey, fallback) {
  return booleanValue(options[name] ?? (envKey ? env[envKey] : undefined) ?? config[name], fallback);
}

function booleanValue(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return fallback;
}

function resolvePath(value) {
  if (value === undefined) {
    return undefined;
  }
  const text = String(value);
  if (text === "~") {
    return homedir();
  }
  if (text.startsWith("~/")) {
    return join(homedir(), text.slice(2));
  }
  return resolve(launchCwd, text);
}

function resolveConfigPath(explicitPath) {
  if (explicitPath) {
    const resolved = resolvePath(explicitPath);
    if (!existsSync(resolved)) {
      fail(`Config file not found: ${resolved}`);
    }
    return resolved;
  }
  const candidates = [
    join(launchCwd, "codex-webgui.json"),
    join(userConfigDir, "codex-webgui.json"),
    join(userConfigDir, "config.json")
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function readConfig(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail(`Config file must contain a JSON object: ${filePath}`);
    }
    return normalizeConfig(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`Invalid JSON config: ${filePath}`);
    }
    throw error;
  }
}

function normalizeConfig(raw) {
  return {
    allowPublicWithoutPassword: raw.allowPublicWithoutPassword ?? raw["allow-public-without-password"],
    allowedOrigins: raw.allowedOrigins ?? raw["allowed-origins"],
    appServerSocket: raw.appServerSocket ?? raw["app-server-socket"],
    approvalPolicy: raw.approvalPolicy ?? raw["approval-policy"],
    authSecret: raw.authSecret ?? raw["auth-secret"],
    build: raw.build,
    codexCommand: raw.codexCommand ?? raw["codex-command"],
    cwd: raw.cwd,
    dataDir: raw.dataDir ?? raw["data-dir"],
    externalAppServer: raw.externalAppServer ?? raw["external-app-server"],
    host: raw.host,
    model: raw.model,
    password: raw.password,
    port: raw.port,
    reasoningEffort: raw.reasoningEffort ?? raw["reasoning-effort"] ?? raw.effort,
    fullControl: raw.fullControl ?? raw["full-control"],
    permissionPreset: raw.permissionPreset ?? raw["permission-preset"] ?? raw.permissions,
    sandbox: raw.sandbox,
    unsafePermissions: raw.unsafePermissions ?? raw["unsafe-permissions"],
    uploadDir: raw.uploadDir ?? raw["upload-dir"]
  };
}

function validatePort(port) {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    fail(`Invalid port: ${port}`);
  }
}

function validatePermissionOptions({ approvalPolicy, sandbox, unsafePermissions }) {
  const safeApprovalPolicies = new Set(["on-request", "untrusted"]);
  const unsafeApprovalPolicies = new Set(["on-request", "untrusted", "on-failure", "never"]);
  const safeSandboxes = new Set(["read-only", "workspace-write"]);
  const unsafeSandboxes = new Set(["read-only", "workspace-write", "danger-full-access"]);
  const allowedApprovalPolicies = unsafePermissions ? unsafeApprovalPolicies : safeApprovalPolicies;
  const allowedSandboxes = unsafePermissions ? unsafeSandboxes : safeSandboxes;
  if (sandbox === "full-control") {
    fail("Use --full-control, or set sandbox to danger-full-access with --unsafe-permissions.");
  }
  if (!allowedApprovalPolicies.has(approvalPolicy)) {
    fail(`Approval policy requires --unsafe-permissions: ${approvalPolicy}`);
  }
  if (!allowedSandboxes.has(sandbox)) {
    fail(`Sandbox requires --unsafe-permissions: ${sandbox}`);
  }
}

function permissionOptionsAreValid(options) {
  const safeApprovalPolicies = new Set(["on-request", "untrusted"]);
  const unsafeApprovalPolicies = new Set(["on-request", "untrusted", "on-failure", "never"]);
  const safeSandboxes = new Set(["read-only", "workspace-write"]);
  const unsafeSandboxes = new Set(["read-only", "workspace-write", "danger-full-access"]);
  if (options.sandbox === "full-control") {
    return false;
  }
  const approvalPolicies = options.unsafePermissions ? unsafeApprovalPolicies : safeApprovalPolicies;
  const sandboxes = options.unsafePermissions ? unsafeSandboxes : safeSandboxes;
  return approvalPolicies.has(options.approvalPolicy) && sandboxes.has(options.sandbox);
}

function hasPermissionConfig(value) {
  return Boolean(value && (value.approvalPolicy !== undefined || value.sandbox !== undefined || value.fullControl !== undefined || value.permissionPreset !== undefined));
}

function validateSafety({ host, password, allowPublicWithoutPassword }) {
  if (isLoopbackHost(host)) {
    return;
  }
  if (password) {
    return;
  }
  if (allowPublicWithoutPassword) {
    console.warn("warning: public bind without CODEX_WEB_UI_PASSWORD requested. API routes will remain unauthorized.");
    return;
  }
  fail(`Refusing to bind ${host} without CODEX_WEB_UI_PASSWORD. Set a password or bind to 127.0.0.1.`);
}

function ensureWritableDir(path) {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function checkCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: launchCwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", (error) => {
      resolve({ ok: false, detail: `${command}: ${error.message}` });
    });
    child.once("exit", (code) => {
      const detail = output.trim().split(/\r?\n/)[0] || command;
      resolve({ ok: code === 0, detail: code === 0 ? detail : `${command} exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}` });
    });
  });
}

function randomSecret(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isLoopbackHost(host) {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function runNext(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin, ...args], {
      cwd: packageRoot,
      env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || code === 130 || code === 143) {
        resolve();
        return;
      }
      reject(new Error(signal ? `next ${args[0]} exited with signal ${signal}` : `next ${args[0]} exited with code ${code ?? "unknown"}`));
    });
  });
}

function printHelp() {
  console.log(`Usage: codex-web-ui [options]
       codex-web-ui init [options]
       codex-web-ui doctor [options]
       codex-web-ui app-server <start|stop|restart|recover|status> [options]

Starts the Codex Web UI using Next.js production mode. By default this also
starts or recovers a detached codex app-server sidecar.

Options:
  -c, --config <path>           JSON config file. Default search:
                                ./codex-webgui.json,
                                ~/.codex-webgui/codex-webgui.json,
                                ~/.codex-webgui/config.json
  --host <host>                 Host to bind. Default: 127.0.0.1
  --port <port>                 Port to bind. Default: 4545
  --password <password>         Set CODEX_WEB_UI_PASSWORD for this process; env is safer
  --auth-secret <secret>        Set CODEX_WEB_UI_AUTH_SECRET for JWT signing
  --allowed-origins <csv>       Set CODEX_WEB_UI_ALLOWED_ORIGINS
  --app-server-socket <path>    Codex app-server Unix socket. Default:
                                ~/.codex-webgui/codex-app-server.sock
  --external-app-server         Use the socket but do not start/recover the
                                app-server sidecar
  --codex-command <command>     Codex command. Default: codex
  --cwd <path>                  Default Codex working directory
  --model <model>               Default Codex model. Default: gpt-5.5
  --effort <effort>             Default reasoning effort. Default: high
  --approval-policy <policy>    on-request, untrusted; unsafe also allows
                                on-failure and never. Default: on-request
  --sandbox <mode>              read-only or workspace-write. Default:
                                workspace-write
  --full-control                Shortcut for --unsafe-permissions,
                                approval-policy never, and
                                danger-full-access sandbox
  --unsafe-permissions          Allow danger-full-access sandbox and more
                                permissive approval policies
  --data-dir <path>             Runtime data/log directory
  --upload-dir <path>           Upload directory
  --build                       Run next build before starting
  --allow-public-without-password
                                Allow non-loopback bind without a password
  -h, --help                    Show help

Defaults:
  Next app cwd:                 package install directory
  Codex cwd:                    current working directory
  Data dir:                     ~/.codex-webgui/data
  Upload dir:                   ~/.codex-webgui/data/uploads
  App-server socket:            ~/.codex-webgui/codex-app-server.sock
  Permissions:                  on-request + workspace-write

First run:
  codex-web-ui init             Write ~/.codex-webgui/config.json
  codex-web-ui doctor           Check Codex CLI, build, auth, dirs, and socket
  codex-web-ui                  Start the Web UI and managed app-server

If no password is configured and the host is loopback, start prints a temporary
local password. Non-loopback hosts require a configured password.

Precedence: CLI options > environment variables > config file > defaults.
If approval-policy, sandbox, or full-control is specified by CLI/env/config,
the server locks that policy and browser requests cannot override it.
`);
}

function printInitHelp() {
  console.log(`Usage: codex-web-ui init [options]

Writes a starter config file. Default: ~/.codex-webgui/config.json

Options:
  -c, --config <path>           Config path to write
  --host <host>                 Host to bind. Default: 127.0.0.1
  --port <port>                 Port to bind. Default: 4545
  --password <password>         Password to store; generated when omitted
  --app-server-socket <path>    App-server socket. Default:
                                ~/.codex-webgui/codex-app-server.sock
  --codex-command <command>     Codex command. Default: codex
  --cwd <path>                  Default Codex working directory. Default:
                                current working directory
  --model <model>               Default Codex model. Default: gpt-5.5
  --effort <effort>             Default reasoning effort. Default: high
  --full-control                Store full-control permission preset
  --data-dir <path>             Runtime data/log directory
  --upload-dir <path>           Upload directory
  --allowed-origins <csv>       CORS allowed origins
  --force                       Overwrite an existing config
  -h, --help                    Show help
`);
}

function printDoctorHelp() {
  console.log(`Usage: codex-web-ui doctor [options]

Checks the local startup prerequisites without starting the Web UI.

Accepts the same config, host, app-server, auth, cwd, model, and permission
options as codex-web-ui start.
`);
}

function printAppServerHelp() {
  console.log(`Usage: codex-web-ui app-server <start|stop|restart|recover|status> [options]

Manages a detached local codex app-server side process.

Options:
  --socket <path>               Unix socket path. Default:
                                ~/.codex-webgui/codex-app-server.sock
  --app-server-socket <path>    Alias for --socket
  --pid-file <path>             PID file. Default: beside the socket
  --log-file <path>             Log file. Default: beside the socket
  --codex-command <command>     Codex command. Default: codex
  -h, --help                    Show help

Examples:
  codex-web-ui app-server start
  codex-web-ui app-server status
  codex-web-ui app-server recover
  codex-web-ui app-server restart --socket ~/.codex-webgui/codex-app-server.sock
`);
}

function fail(message) {
  console.error(`codex-web-ui: ${message}`);
  process.exit(1);
}
