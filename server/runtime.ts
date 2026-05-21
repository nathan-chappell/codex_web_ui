import os from "node:os";
import path from "node:path";
import { CodexBridge } from "./codexBridge";
import { EventHub } from "./eventHub";
import { SessionLogStore } from "./logStore";

export const projectRoot = path.resolve(/*turbopackIgnore: true*/ process.cwd());
export const homeDir = os.homedir();

const logs = new SessionLogStore(process.env.CODEX_WEB_UI_DATA_DIR || path.join(projectRoot, "data"));
const hub = new EventHub();
const bridge = new CodexBridge(
  {
    command: process.env.CODEX_COMMAND || "codex",
    cwd: process.env.CODEX_CWD || projectRoot,
    model: process.env.CODEX_MODEL || "gpt-5.5",
    reasoningEffort: process.env.CODEX_REASONING_EFFORT || "high",
    fastMode: process.env.CODEX_FAST_MODE !== "0",
    appServerSocketPath: process.env.CODEX_APP_SERVER_SOCKET || ""
  },
  hub,
  logs
);

let readyPromise: Promise<void> | null = null;

export async function getRuntime(): Promise<{ bridge: CodexBridge; hub: EventHub; logs: SessionLogStore }> {
  readyPromise ??= logs.ensure();
  await readyPromise;
  return { bridge, hub, logs };
}
