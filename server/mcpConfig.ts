import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { homeDir } from "./runtime";

export interface McpServerInput {
  name: string;
  url: string;
}

export function codexConfigPath(): string {
  if (process.env.CODEX_CONFIG_PATH) {
    return path.resolve(process.env.CODEX_CONFIG_PATH);
  }
  return path.join(process.env.CODEX_HOME || path.join(homeDir, ".codex"), "config.toml");
}

export async function saveMcpServerConfig(input: McpServerInput): Promise<{ configPath: string }> {
  const name = validateServerName(input.name);
  const url = validateServerUrl(input.url);
  const configPath = codexConfigPath();
  const existing = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const { text } = removeMcpServerBlock(existing, name);
  const nextBlock = [
    `[mcp_servers.${name}]`,
    `url = "${tomlStringValue(url)}"`
  ].join("\n");
  const nextText = `${text.trimEnd()}${text.trimEnd() ? "\n\n" : ""}${nextBlock}\n`;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, nextText, "utf8");
  return { configPath };
}

function validateServerName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
    throw new Error("MCP server name must be 1-80 letters, numbers, dashes, or underscores");
  }
  return name;
}

function validateServerUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Enter a valid MCP server URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MCP server URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Put MCP credentials in the bearer token field, not the URL");
  }
  if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname)) {
    throw new Error("Plain HTTP MCP servers must be localhost or loopback");
  }
  return parsed.toString();
}

function isLocalHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "0.0.0.0" || value === "::1" || value.startsWith("127.");
}

function removeMcpServerBlock(text: string, name: string): { text: string; block: string | null } {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  const removed: string[] = [];
  let removing = false;
  for (const line of lines) {
    if (isTableHeader(line)) {
      removing = tableName(line) === `mcp_servers.${name}`;
    }
    if (removing) {
      removed.push(line);
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join("\n"), block: removed.length ? removed.join("\n") : null };
}

function isTableHeader(line: string): boolean {
  return /^\s*\[[^\]]+\]\s*$/.test(line);
}

function tableName(line: string): string {
  return line.trim().replace(/^\[|\]$/g, "").replace(/"([^"]+)"/g, "$1");
}

function tomlStringValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
