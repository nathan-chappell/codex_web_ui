# Changelog

## 1.0.13

- Kept the Tail toggle visible in the composer and made tailing entirely controlled by that toggle.
- Removed the Goal shortcut from the composer dots menu while preserving typed `/goal` command support.
- Humanized status badge labels such as `inProgress` to `In Progress`.

## 1.0.12

- Removed the deprecated `--external-app-server` no-op and the old stdio-owned app-server fallback from the web bridge.
- Clarified `--permissions`, `--approval-policy`, and `--unsafe-permissions` in CLI help and README security docs.
- Added `/goal` composer commands backed by the official `thread/goal/*` app-server RPCs.

## 1.0.11

- Simplified global permission config so full-control unlocks per-thread escalation while restricted defaults remain `on-request` plus `workspace-write`.
- Added explicit CORS allow/reject security tests and permission-mode regression tests.

## 1.0.10

- Removed the project-specific agriculture ontology MCP defaults from the add-server form.

## 1.0.9

- Made `codex-web-ui init` output clearer about the generated login password, where it is stored, and how to start the app-server sidecar.
- Updated first-run documentation to include explicit sidecar startup.

## 1.0.8

- Simplified app-server lifecycle ownership: `codex-web-ui` now requires a running websocket-ready app-server socket and no longer starts or recovers the sidecar from the web process.
- Removed the browser app-server recovery action; use `codex-web-ui app-server start|recover|restart` from the CLI instead.
- Added a Docker entrypoint that starts the sidecar explicitly before launching the web UI.

## 1.0.7

- Fixed app-server recovery from installed packages by passing the real CLI path into the Next server.
- Changed app-server health checks to verify the Unix socket accepts the WebSocket upgrade instead of only accepting a raw socket connection.

## 1.0.6

- Removed thread-list multi-select and bulk archive controls.
- Made composer collapse an explicit global preference instead of scroll-driven behavior.

## 1.0.5

- Changed reasoning items from expandable cards to compact static summaries in thread view.

## 1.0.4

- Added a deployment smoke test that installs the published npm package into a temporary directory, starts it on `0.0.0.0:4546` with password `codex`, verifies auth/login, and cleans up the fresh app-server socket.
- Fixed thread selection to update browser history without remounting the Next route, reducing cases where choosing a thread appears to reload the thread list.
- Improved thread item readability with better padding around reasoning rows, smaller non-final item text, and friendlier phase labels.
- Centered the underscore in the app icon/logo.
- Documented Cloudflare Tunnel usage as a tested remote-access path.

## 1.0.3

- Published the npm package under `@nchappell/codex-web-ui`.
- Updated the Docker image to install Codex Web UI from npm during image build.
- Added Docker smoke coverage for the npm-installed image path.
