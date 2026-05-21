import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = process.cwd();
const nextOutDir = path.join(projectRoot, "out");
const staticDir = path.join(projectRoot, "dist", "public");

await run("next build", ["next", "build"]);
await rm(staticDir, { recursive: true, force: true });
await cp(nextOutDir, staticDir, { recursive: true });
console.log(`[build:client] copied ${path.relative(projectRoot, nextOutDir)} to ${path.relative(projectRoot, staticDir)}`);

function run(label, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, { cwd: projectRoot, env: process.env, stdio: "inherit" });
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
