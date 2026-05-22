#!/usr/bin/env node

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseArgs as parseNodeArgs } from "node:util";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launchCwd = process.cwd();
const userConfigDir = join(homedir(), ".codex-webgui");
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const rawArgs = process.argv.slice(2);

if (rawArgs[0] === "app-server") {
  await runAppServerCommand(parseAppServerArgs(rawArgs.slice(1)));
  process.exit(0);
}

const options = parseArgs(rawArgs);

if (options.help) {
  printHelp();
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
const requestedSandbox = pick("sandbox", "CODEX_WEB_UI_SANDBOX", "workspace-write");
const fullControl = pickBoolean("fullControl", "CODEX_WEB_UI_FULL_CONTROL", false) || requestedSandbox === "full-control" || pick("permissionPreset", "CODEX_WEB_UI_PERMISSION_PRESET") === "full-control";
const unsafePermissions = fullControl || pickBoolean("unsafePermissions", "CODEX_WEB_UI_UNSAFE_PERMISSIONS", false);
const approvalPolicy = pick("approvalPolicy", "CODEX_WEB_UI_APPROVAL_POLICY", "on-request");
const sandbox = fullControl ? "danger-full-access" : requestedSandbox;
const permissionsSpecified = hasPermissionConfig(options) || hasPermissionConfig(config) || Boolean(
  env.CODEX_WEB_UI_APPROVAL_POLICY
  || env.CODEX_WEB_UI_SANDBOX
  || env.CODEX_WEB_UI_FULL_CONTROL
  || env.CODEX_WEB_UI_PERMISSION_PRESET
  || env.CODEX_WEB_UI_LOCK_PERMISSIONS
);

setEnv(env, "HOST", host);
setEnv(env, "PORT", port);
setEnv(env, "CODEX_WEB_UI_PASSWORD", pick("password", "CODEX_WEB_UI_PASSWORD"));
setEnv(env, "CODEX_WEB_UI_AUTH_SECRET", pick("authSecret", "CODEX_WEB_UI_AUTH_SECRET"));
setEnv(env, "CODEX_WEB_UI_ALLOWED_ORIGINS", pick("allowedOrigins", "CODEX_WEB_UI_ALLOWED_ORIGINS"));
setEnv(env, "CODEX_WEB_UI_DATA_DIR", dataDir);
setEnv(env, "CODEX_WEB_UI_UPLOAD_DIR", uploadDir);
setEnv(env, "CODEX_APP_SERVER_SOCKET", resolvePath(pick("appServerSocket", "CODEX_APP_SERVER_SOCKET")));
setEnv(env, "CODEX_COMMAND", pick("codexCommand", "CODEX_COMMAND"));
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

console.log(`codex-web-ui listening on http://${host}:${port}`);
console.log(`codex-web-ui app cwd: ${packageRoot}`);
console.log(`codex default cwd: ${env.CODEX_CWD}`);
console.log(`runtime data dir: ${env.CODEX_WEB_UI_DATA_DIR}`);
console.log(`permissions: approval=${env.CODEX_WEB_UI_APPROVAL_POLICY}, sandbox=${env.CODEX_WEB_UI_SANDBOX}${env.CODEX_WEB_UI_LOCK_PERMISSIONS === "1" ? ", locked" : ""}${unsafePermissions ? ", unsafe enabled" : ""}`);
if (configPath) {
  console.log(`config file: ${configPath}`);
}
if (!env.CODEX_WEB_UI_PASSWORD) {
  console.warn("warning: CODEX_WEB_UI_PASSWORD is not set. Login is disabled and API routes remain unauthorized.");
}
if (!env.CODEX_APP_SERVER_SOCKET) {
  console.warn("warning: CODEX_APP_SERVER_SOCKET is not set. The web UI may spawn and own a Codex app-server process.");
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
    const socket = resolvePath(values.socket ?? values["app-server-socket"] ?? process.env.CODEX_APP_SERVER_SOCKET ?? join(launchCwd, "tmp", "codex-app-server.sock"));
    const runtimeDir = dirname(socket);
    return {
      action: positionals[0] ?? (values.help ? "help" : "status"),
      command: values["codex-command"] ?? process.env.CODEX_COMMAND ?? "codex",
      help: values.help,
      logFile: resolvePath(values["log-file"] ?? process.env.CODEX_APP_SERVER_LOG_FILE ?? join(runtimeDir, "codex-app-server.log")),
      pidFile: resolvePath(values["pid-file"] ?? process.env.CODEX_APP_SERVER_PID_FILE ?? join(runtimeDir, "codex-app-server.pid")),
      socket
    };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function runAppServerCommand(options) {
  if (options.help || options.action === "help") {
    printAppServerHelp();
    return;
  }
  if (!["start", "stop", "restart", "status"].includes(options.action)) {
    fail(`Unknown app-server command: ${options.action}`);
  }
  if (options.action === "start") {
    startAppServer(options);
    return;
  }
  if (options.action === "stop") {
    await stopAppServer(options);
    return;
  }
  if (options.action === "restart") {
    await stopAppServer(options, { quiet: true });
    startAppServer(options);
    return;
  }
  printAppServerStatus(options);
}

function startAppServer(options) {
  const existingPid = readPid(options.pidFile);
  if (existingPid && isPidRunning(existingPid)) {
    console.log(`codex app-server already running: pid=${existingPid}`);
    console.log(`socket: ${options.socket}`);
    return;
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
  console.log(`codex app-server started: pid=${child.pid}`);
  console.log(`socket: ${options.socket}`);
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

function printAppServerStatus(options) {
  const pid = readPid(options.pidFile);
  const running = Boolean(pid && isPidRunning(pid));
  console.log(`codex app-server ${running ? "running" : "stopped"}${pid ? `: pid=${pid}` : ""}`);
  console.log(`socket: ${options.socket}${existsSync(options.socket) ? " (present)" : " (missing)"}`);
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
       codex-web-ui app-server <start|stop|restart|status> [options]

Starts the Codex Web UI using Next.js production mode.

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
  --app-server-socket <path>    Use an existing codex app-server Unix socket
  --codex-command <command>     Codex command. Default: codex
  --cwd <path>                  Default Codex working directory
  --model <model>               Default Codex model. Default: gpt-5.5
  --effort <effort>             Default reasoning effort. Default: high
  --approval-policy <policy>    on-request, untrusted; unsafe also allows
                                on-failure and never. Default: on-request
  --sandbox <mode>              read-only or workspace-write. Default:
                                workspace-write
  --full-control                Shortcut for --unsafe-permissions plus
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
  Permissions:                  on-request + workspace-write

Precedence: CLI options > environment variables > config file > defaults.
If approval-policy, sandbox, or full-control is specified by CLI/env/config,
the server locks that policy and browser requests cannot override it.
`);
}

function printAppServerHelp() {
  console.log(`Usage: codex-web-ui app-server <start|stop|restart|status> [options]

Manages a detached local codex app-server side process.

Options:
  --socket <path>               Unix socket path. Default:
                                ./tmp/codex-app-server.sock
  --app-server-socket <path>    Alias for --socket
  --pid-file <path>             PID file. Default: beside the socket
  --log-file <path>             Log file. Default: beside the socket
  --codex-command <command>     Codex command. Default: codex
  -h, --help                    Show help

Examples:
  codex-web-ui app-server start
  codex-web-ui app-server status
  codex-web-ui app-server restart --socket ./tmp/codex-app-server.sock
`);
}

function fail(message) {
  console.error(`codex-web-ui: ${message}`);
  process.exit(1);
}
