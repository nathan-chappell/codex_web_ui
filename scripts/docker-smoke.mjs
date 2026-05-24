#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const image = process.env.CODEX_WEB_UI_DOCKER_IMAGE || "codex-web-ui:smoke";
const npmSpec = process.env.CODEX_WEB_UI_DOCKER_NPM_SPEC || `${packageJson.name}@${packageJson.version}`;
const port = Number(process.env.CODEX_WEB_UI_DOCKER_PORT || "4555");
const password = process.env.CODEX_WEB_UI_DOCKER_PASSWORD || "docker-smoke-password";
const authSecret = process.env.CODEX_WEB_UI_DOCKER_AUTH_SECRET || "docker-smoke-auth-secret";
const skipBuild = truthy(process.env.CODEX_WEB_UI_DOCKER_SKIP_BUILD);
const keepContainer = truthy(process.env.CODEX_WEB_UI_DOCKER_KEEP);
const containerName = `codex-web-ui-smoke-${process.pid}`;

let dataDir = "";
let codexDir = "";

try {
  await command("docker", ["version", "--format", "{{.Server.Version}}"], { label: "checking Docker" });
  if (!skipBuild) {
    await command("docker", [
      "build",
      "--build-arg",
      `CODEX_WEB_UI_NPM_SPEC=${npmSpec}`,
      "-t",
      image,
      "."
    ], { label: `building ${image} from ${npmSpec}` });
  }

  await command("docker", ["run", "--rm", "--entrypoint", "npm", image, "ls", "-g", packageJson.name, "--depth=0"], {
    label: "checking installed npm package"
  });

  dataDir = await mkdtemp(path.join(tmpdir(), "codex-web-ui-docker-data-"));
  codexDir = await mkdtemp(path.join(tmpdir(), "codex-web-ui-docker-codex-"));

  await command("docker", [
    "run",
    "--rm",
    "--detach",
    "--name",
    containerName,
    "-p",
    `${port}:4545`,
    "-e",
    `CODEX_WEB_UI_PASSWORD=${password}`,
    "-e",
    `CODEX_WEB_UI_AUTH_SECRET=${authSecret}`,
    "-v",
    `${dataDir}:/home/node/.codex-webgui`,
    "-v",
    `${codexDir}:/home/node/.codex`,
    "-v",
    `${process.cwd()}:/workspace:ro`,
    image,
    "--host",
    "0.0.0.0",
    "--cwd",
    "/workspace",
    "--external-app-server",
    "--app-server-socket",
    "/home/node/.codex-webgui/missing.sock"
  ], { label: "starting container" });

  await waitForHttp(`http://127.0.0.1:${port}/threads`);
  const auth = await json(`http://127.0.0.1:${port}/api/auth`);
  if (auth.ok !== true || auth.authenticated !== false || auth.mode !== "password") {
    throw new Error(`Unexpected /api/auth response: ${JSON.stringify(auth)}`);
  }

  const login = await json(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  if (typeof login.token !== "string" || !login.authenticated) {
    throw new Error("Docker login smoke failed");
  }

  console.log(`Docker smoke passed for ${image} on port ${port}`);
} finally {
  if (containerName && !keepContainer) {
    await command("docker", ["rm", "-f", containerName], { allowFailure: true, quiet: true });
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (codexDir) await rm(codexDir, { recursive: true, force: true });
}

async function waitForHttp(url) {
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
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function command(binary, args, options = {}) {
  if (!options.quiet) {
    console.log(`${options.label || binary}: ${binary} ${args.join(" ")}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: process.cwd(),
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

function truthy(value) {
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
