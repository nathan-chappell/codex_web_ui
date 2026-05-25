import assert from "node:assert/strict";
import test from "node:test";
import { enforceRpcPermissions, getPermissionPolicy } from "../../server/permissions";

test("restricted permissions block per-thread full-control requests", () => {
  withPermissionEnv({ unsafe: "0", locked: "0", approval: "on-request", sandbox: "workspace-write" }, () => {
    assert.throws(
      () => enforceRpcPermissions("turn/start", {
        threadId: "thread",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" }
      }),
      /requires unsafe permissions|requires --unsafe-permissions/
    );
  });
});

test("full-control mode unlocks per-thread escalation without changing restricted defaults", () => {
  withPermissionEnv({ unsafe: "1", locked: "0", approval: "on-request", sandbox: "workspace-write" }, () => {
    const policy = getPermissionPolicy();
    assert.equal(policy.mode, "full-control");
    assert.equal(policy.defaultApprovalPolicy, "on-request");
    assert.equal(policy.defaultSandbox, "workspace-write");
    assert.equal(policy.locked, false);

    const params = enforceRpcPermissions("turn/start", {
      threadId: "thread",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    });
    assert.deepEqual(params, {
      threadId: "thread",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    });
  });
});

test("locked permission mode overrides per-thread requests", () => {
  withPermissionEnv({ unsafe: "1", locked: "1", approval: "on-request", sandbox: "workspace-write" }, () => {
    const params = enforceRpcPermissions("turn/start", {
      threadId: "thread",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    });
    assert.deepEqual(params, {
      threadId: "thread",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" }
    });
  });
});

function withPermissionEnv(
  values: { unsafe: string; locked: string; approval: string; sandbox: string },
  fn: () => void
): void {
  const previous = {
    unsafe: process.env.CODEX_WEB_UI_UNSAFE_PERMISSIONS,
    locked: process.env.CODEX_WEB_UI_LOCK_PERMISSIONS,
    approval: process.env.CODEX_WEB_UI_APPROVAL_POLICY,
    sandbox: process.env.CODEX_WEB_UI_SANDBOX
  };
  process.env.CODEX_WEB_UI_UNSAFE_PERMISSIONS = values.unsafe;
  process.env.CODEX_WEB_UI_LOCK_PERMISSIONS = values.locked;
  process.env.CODEX_WEB_UI_APPROVAL_POLICY = values.approval;
  process.env.CODEX_WEB_UI_SANDBOX = values.sandbox;
  try {
    fn();
  } finally {
    restoreEnv("CODEX_WEB_UI_UNSAFE_PERMISSIONS", previous.unsafe);
    restoreEnv("CODEX_WEB_UI_LOCK_PERMISSIONS", previous.locked);
    restoreEnv("CODEX_WEB_UI_APPROVAL_POLICY", previous.approval);
    restoreEnv("CODEX_WEB_UI_SANDBOX", previous.sandbox);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
