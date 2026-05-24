import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const fixturePath = path.resolve("tests/fixtures/preview-smoke.svg");
const fixtureName = path.basename(fixturePath);

test("opens a local image fixture in the file preview flow", async ({ page }) => {
  await mockCodexApi(page);

  await page.goto("/threads");
  await expect(page.getByRole("heading", { name: "Threads" })).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).first().click();
  await page.getByRole("menuitem", { name: "Files" }).click();

  await expect(page.getByRole("dialog", { name: "Files" })).toBeVisible();
  await page.getByRole("treeitem", { name: new RegExp(fixtureName) }).click();

  await expect(page.getByRole("dialog", { name: fixtureName })).toBeVisible();
  const preview = page.getByRole("img", { name: fixtureName });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveJSProperty("complete", true);
  await expect
    .poll(async () => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
});

async function mockCodexApi(page: Page) {
  await page.route("**/api/auth", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        authenticated: true,
        mode: "password",
        warning: null,
        user: { id: "test", email: null, name: "Test user", role: "admin" },
        tokenExpiresAt: Date.now() + 60 * 60 * 1000,
        permissionPolicy: {
          defaultApprovalPolicy: "on-request",
          defaultSandbox: "workspace-write",
          locked: false,
          unsafePermissions: true,
          allowedApprovalPolicies: ["on-request", "untrusted", "on-failure", "never"],
          allowedSandboxes: ["read-only", "workspace-write", "danger-full-access"]
        }
      })
    })
  );

  await page.route("**/api/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: { state: "disconnected", cwd: process.cwd(), error: null }
      })
    })
  );

  await page.route("**/api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'event: hello\ndata: {"history":[]}\n\n'
    })
  );

  await page.route("**/api/client-requests", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, requests: [] })
    })
  );

  await page.route("**/api/rpc", handleRpc);
  await page.route("**/api/files/explore**", handleFilesExplore);
  await page.route("**/api/files/view**", handleFilesView);
  await page.route("**/api/files/raw**", handleFilesRaw);
}

async function handleRpc(route: Route) {
  const body = route.request().postDataJSON() as { method?: string };
  const result =
    body.method === "thread/list"
      ? { data: [] }
      : body.method === "thread/loaded/list"
        ? { data: [] }
        : body.method === "account/rateLimits/read"
          ? { data: [] }
          : {};

  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, result })
  });
}

async function handleFilesExplore(route: Route) {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      explorer: {
        cwd: process.cwd(),
        path: process.cwd(),
        relativePath: "",
        displayPath: process.cwd(),
        parentPath: null,
        trackedCount: 1,
        entries: [
          {
            name: fixtureName,
            path: fixturePath,
            relativePath: path.relative(process.cwd(), fixturePath),
            displayPath: fixturePath,
            type: "file",
            tracked: true,
            size: 360,
            modifiedAt: Date.now(),
            kind: "image",
            previewable: true
          }
        ]
      }
    })
  });
}

async function handleFilesView(route: Route) {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      file: {
        path: fixturePath,
        displayPath: fixturePath,
        name: fixtureName,
        extension: "svg",
        mimeType: "image/svg+xml",
        size: 360,
        kind: "image",
        previewable: true
      }
    })
  });
}

async function handleFilesRaw(route: Route) {
  await route.fulfill({
    contentType: "image/svg+xml",
    body: await readFile(fixturePath, "utf8")
  });
}
