#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const env = { ...process.env };
const host = options.host ?? env.HOST ?? "127.0.0.1";
const port = options.port ?? env.PORT ?? "4545";

setEnv(env, "HOST", host);
setEnv(env, "PORT", port);
setEnv(env, "CODEX_WEB_UI_PASSWORD", options.password);
setEnv(env, "CODEX_WEB_UI_AUTH_SECRET", options.authSecret);
setEnv(env, "CODEX_WEB_UI_ALLOWED_ORIGINS", options.allowedOrigins);
setEnv(env, "CODEX_WEB_UI_DATA_DIR", options.dataDir);
setEnv(env, "CODEX_WEB_UI_UPLOAD_DIR", options.uploadDir);
setEnv(env, "CODEX_APP_SERVER_SOCKET", options.appServerSocket);
setEnv(env, "CODEX_COMMAND", options.codexCommand);
setEnv(env, "CODEX_CWD", options.cwd);
setEnv(env, "CODEX_MODEL", options.model);
setEnv(env, "CODEX_REASONING_EFFORT", options.reasoningEffort);

validatePort(port);
validateSafety({ host, password: env.CODEX_WEB_UI_PASSWORD, allowPublicWithoutPassword: options.allowPublicWithoutPassword });

if (options.build) {
  await runNext(["build"], env);
}

if (!existsSync(join(packageRoot, ".next", "BUILD_ID"))) {
  fail("No Next production build found. Run `codex-web-ui --build` once, or install a package that includes the built app.");
}

console.log(`codex-web-ui listening on http://${host}:${port}`);
if (!env.CODEX_WEB_UI_PASSWORD) {
  console.warn("warning: CODEX_WEB_UI_PASSWORD is not set. Login is disabled and API routes remain unauthorized.");
}
if (!env.CODEX_APP_SERVER_SOCKET) {
  console.warn("warning: CODEX_APP_SERVER_SOCKET is not set. The web UI may spawn and own a Codex app-server process.");
}

await runNext(["start", "--hostname", host, "--port", port], env);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--build") {
      parsed.build = true;
      continue;
    }
    if (arg === "--allow-public-without-password") {
      parsed.allowPublicWithoutPassword = true;
      continue;
    }
    const key = arg.startsWith("--") ? arg.slice(2) : "";
    const optionName = optionKey(key);
    if (!optionName) {
      fail(`Unknown option: ${arg}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${arg}`);
    }
    parsed[optionName] = value;
    index += 1;
  }
  return parsed;
}

function optionKey(key) {
  return {
    host: "host",
    port: "port",
    password: "password",
    "auth-secret": "authSecret",
    "allowed-origins": "allowedOrigins",
    "data-dir": "dataDir",
    "upload-dir": "uploadDir",
    "app-server-socket": "appServerSocket",
    "codex-command": "codexCommand",
    cwd: "cwd",
    model: "model",
    effort: "reasoningEffort",
    "reasoning-effort": "reasoningEffort"
  }[key];
}

function setEnv(env, key, value) {
  if (value !== undefined) {
    env[key] = value;
  }
}

function validatePort(port) {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    fail(`Invalid port: ${port}`);
  }
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
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal ? `next ${args[0]} exited with signal ${signal}` : `next ${args[0]} exited with code ${code ?? "unknown"}`));
    });
  });
}

function printHelp() {
  console.log(`Usage: codex-web-ui [options]

Starts the Codex Web UI using Next.js production mode.

Options:
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
  --data-dir <path>             Runtime data/log directory
  --upload-dir <path>           Upload directory
  --build                       Run next build before starting
  --allow-public-without-password
                                Allow non-loopback bind without a password
  -h, --help                    Show help
`);
}

function fail(message) {
  console.error(`codex-web-ui: ${message}`);
  process.exit(1);
}
