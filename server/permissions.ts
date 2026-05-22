import type { JsonValue } from "./types";

export type ApprovalPolicy = "on-request" | "untrusted" | "on-failure" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface PermissionPolicy {
  defaultApprovalPolicy: ApprovalPolicy;
  defaultSandbox: SandboxMode;
  locked: boolean;
  unsafePermissions: boolean;
  allowedApprovalPolicies: ApprovalPolicy[];
  allowedSandboxes: SandboxMode[];
}

const safeApprovalPolicies: ApprovalPolicy[] = ["on-request", "untrusted"];
const unsafeApprovalPolicies: ApprovalPolicy[] = ["on-request", "untrusted", "on-failure", "never"];
const safeSandboxes: SandboxMode[] = ["read-only", "workspace-write"];
const unsafeSandboxes: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

export function getPermissionPolicy(): PermissionPolicy {
  const unsafePermissions = booleanEnv("CODEX_WEB_UI_UNSAFE_PERMISSIONS", false);
  const allowedApprovalPolicies = unsafePermissions ? unsafeApprovalPolicies : safeApprovalPolicies;
  const allowedSandboxes = unsafePermissions ? unsafeSandboxes : safeSandboxes;
  const defaultApprovalPolicy = approvalPolicyFor(process.env.CODEX_WEB_UI_APPROVAL_POLICY) ?? "on-request";
  const defaultSandbox = sandboxFor(process.env.CODEX_WEB_UI_SANDBOX) ?? "workspace-write";

  if (!allowedApprovalPolicies.includes(defaultApprovalPolicy)) {
    throw httpError(500, `Configured approval policy requires unsafe permissions: ${defaultApprovalPolicy}`);
  }
  if (!allowedSandboxes.includes(defaultSandbox)) {
    throw httpError(500, `Configured sandbox requires unsafe permissions: ${defaultSandbox}`);
  }

  return {
    defaultApprovalPolicy,
    defaultSandbox,
    locked: booleanEnv("CODEX_WEB_UI_LOCK_PERMISSIONS", false),
    unsafePermissions,
    allowedApprovalPolicies,
    allowedSandboxes
  };
}

export function enforceRpcPermissions(method: string, params: JsonValue): JsonValue {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }
  if (!usesPermissions(method)) {
    return params;
  }

  const policy = getPermissionPolicy();
  const next: Record<string, JsonValue> = { ...(params as Record<string, JsonValue>) };
  const requestedApprovalPolicy = approvalPolicyFor(next.approvalPolicy);
  const requestedSandbox = sandboxFor(next.sandbox) ?? sandboxFor(next.sandboxPolicy);

  const approvalPolicy = policy.locked
    ? policy.defaultApprovalPolicy
    : validateApprovalPolicy(requestedApprovalPolicy ?? policy.defaultApprovalPolicy, policy);
  const sandbox = policy.locked
    ? policy.defaultSandbox
    : validateSandbox(requestedSandbox ?? policy.defaultSandbox, policy);

  if (method === "turn/start" || method === "thread/start") {
    next.approvalPolicy = approvalPolicy;
  }
  if (method === "turn/start") {
    next.sandboxPolicy = sandboxPolicyFor(sandbox);
    delete next.sandbox;
  } else {
    next.sandbox = sandbox;
    delete next.sandboxPolicy;
  }

  return next;
}

function usesPermissions(method: string): boolean {
  return method === "thread/start" || method === "thread/resume" || method === "thread/fork" || method === "turn/start";
}

function validateApprovalPolicy(value: ApprovalPolicy, policy: PermissionPolicy): ApprovalPolicy {
  if (!policy.allowedApprovalPolicies.includes(value)) {
    throw httpError(403, `Approval policy requires unsafe permissions: ${value}`);
  }
  return value;
}

function validateSandbox(value: SandboxMode, policy: PermissionPolicy): SandboxMode {
  if (!policy.allowedSandboxes.includes(value)) {
    throw httpError(403, `Sandbox requires --unsafe-permissions: ${value}`);
  }
  return value;
}

function approvalPolicyFor(value: unknown): ApprovalPolicy | null {
  return value === "on-request" || value === "untrusted" || value === "on-failure" || value === "never" ? value : null;
}

function sandboxFor(value: unknown): SandboxMode | null {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "readOnly") return "read-only";
  if (record.type === "workspaceWrite") return "workspace-write";
  if (record.type === "dangerFullAccess") return "danger-full-access";
  return null;
}

function sandboxPolicyFor(value: SandboxMode): JsonValue {
  if (value === "danger-full-access") return { type: "dangerFullAccess" };
  if (value === "read-only") return { type: "readOnly" };
  return { type: "workspaceWrite" };
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
