import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev:api"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:client"], { stdio: "inherit" })
];

let shuttingDown = false;

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopChildren();
    process.exit(code ?? (signal ? 1 : 0));
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
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}
