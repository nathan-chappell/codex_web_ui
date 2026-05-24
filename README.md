# Codex Web UI

TypeScript web UI for controlling `codex app-server` remotely.

This project does not reimplement Codex. It is a client/UI layer over the
official `codex app-server`.

Status: workaround / experimental.

Target: Linux/Ubuntu users who want a mobile-friendly Codex UI before an
official Linux Codex app exists.

The app is a Next.js App Router application with Tailwind, shadcn/ui, and AI Elements components. UI routes live under `/threads` and `/thread/[threadId]`; API endpoints are implemented as Next route handlers under `/api`.

## Requirements

- Node.js 20 or newer.
- The official Codex CLI installed as `codex`.
- A working Codex login; check with `codex login status`.

## Install from npm

```bash
npm install -g @nchappell/codex-web-ui
codex-web-ui init
codex-web-ui doctor
codex-web-ui
```

Open `http://127.0.0.1:4545`.

The normal startup command starts the Next.js server and starts or recovers a
detached `codex app-server` sidecar on a Unix socket. Run `codex-web-ui doctor`
after install or upgrade to check the production build, Codex CLI availability,
login status, auth setup, writable data directories, permission settings, and
app-server socket.

For source or git installs, run `codex-web-ui --build` once if the package does
not include a `.next` production build.

## Run from source

```bash
npm install
npm run build
node ./bin/codex-web-ui.js init
node ./bin/codex-web-ui.js doctor
node ./bin/codex-web-ui.js
```

Open `http://127.0.0.1:4545`.

## Container Image

The repository includes a Dockerfile for users who prefer an isolated runtime
over a global npm install. The image installs the released npm package during
`docker build`; it does not copy the local checkout into the image.

```bash
docker build -t codex-web-ui .
docker run --rm -it \
  -p 4545:4545 \
  -e CODEX_WEB_UI_PASSWORD='change-me' \
  -e CODEX_WEB_UI_AUTH_SECRET='separate-token-signing-secret' \
  -v "$HOME/.codex:/home/node/.codex" \
  -v "$HOME/.codex-webgui:/home/node/.codex-webgui" \
  -v "$PWD:/workspace" \
  codex-web-ui --cwd /workspace
```

The image includes the official Codex CLI and stores Web UI runtime data under
`/home/node/.codex-webgui`. Mount `~/.codex` if you want to reuse an existing
Codex login. Do not bake passwords, OpenAI keys, tunnel tokens, or Codex
credentials into the image.

From a repository checkout, smoke-test the container wiring without requiring a
Codex login or a live app-server socket:

```bash
npm run test:docker
```

The Docker smoke builds `codex-web-ui:smoke`, starts it on port `4555` with a
temporary data directory and `--external-app-server`, verifies `/threads`,
`/api/auth`, and password login, then removes the container and temp volumes.
By default it builds with `@nchappell/codex-web-ui@<package.json version>` from
npm. Set `CODEX_WEB_UI_DOCKER_NPM_SPEC=@nchappell/codex-web-ui@latest` or
another npm package spec to test a different published package,
`CODEX_WEB_UI_DOCKER_IMAGE=<tag>` to change the local image tag, or
`CODEX_WEB_UI_DOCKER_SKIP_BUILD=1` to reuse an existing image.

To smoke-test the published npm deployment path, install the package into a
temporary directory and run it with a fresh app-server socket:

```bash
npm run test:deployment
```

The deployment smoke defaults to `@nchappell/codex-web-ui@<package.json
version>`, binds `0.0.0.0:4546`, uses password `codex`, verifies `/api/auth`
and password login, then stops the temporary server. Set
`CODEX_WEB_UI_DEPLOYMENT_NPM_SPEC`, `CODEX_WEB_UI_DEPLOYMENT_PORT`, or
`CODEX_WEB_UI_DEPLOYMENT_KEEP=1` to adjust it.

## CLI

The npm package exposes a `codex-web-ui` command:

```bash
codex-web-ui init
codex-web-ui doctor
codex-web-ui
codex-web-ui --help
codex-web-ui --port 4545
CODEX_WEB_UI_PASSWORD='change-me' codex-web-ui --host 0.0.0.0
CODEX_WEB_UI_PASSWORD='change-me' codex-web-ui --host 0.0.0.0 --full-control
codex-web-ui --app-server-socket ~/.codex-webgui/codex-app-server.sock --model gpt-5.5 --effort high
codex-web-ui --config ./codex-webgui.json
```

By default the CLI binds to `127.0.0.1:4545`. Binding to a non-loopback host
requires `CODEX_WEB_UI_PASSWORD` or `--password`; this is intentional because
the app can read local files through authenticated preview/download endpoints.
If no password is configured on a loopback host, startup prints a temporary
local password for that process. Run `codex-web-ui init` to create a stable
password-backed config.

The CLI uses these directory defaults:

- Next app cwd: the package install directory.
- Codex cwd: the current working directory where `codex-web-ui` was launched.
- Runtime data: `~/.codex-webgui/data`.
- Uploads: `~/.codex-webgui/data/uploads`.
- Managed app-server socket: `~/.codex-webgui/codex-app-server.sock`.

`codex-web-ui doctor` checks the production build, Codex CLI availability and
login status, auth setup, writable data directories, permission settings, and
app-server socket. It does not start the Web UI.

Useful CLI options:

```bash
codex-web-ui \
  --host 127.0.0.1 \
  --port 4545 \
  --app-server-socket ~/.codex-webgui/codex-app-server.sock \
  --cwd /path/to/project \
  --model gpt-5.5 \
  --effort high \
  --approval-policy on-request \
  --sandbox workspace-write \
  --data-dir "$PWD/data"
```

The main command manages the app-server sidecar by default. If you already run
the official app-server yourself, pass `--external-app-server` with
`--app-server-socket`; in that mode startup only connects to the socket and does
not attempt recovery.

Default permissions are intentionally conservative: `on-request` approval and
`workspace-write` sandbox. `danger-full-access`, `on-failure`, and `never`
require `--unsafe-permissions` or `CODEX_WEB_UI_UNSAFE_PERMISSIONS=1`.
For the common trusted local-network case, `--full-control` is a shortcut for
unsafe permissions, `never` approval, and the `danger-full-access` sandbox. If
`approvalPolicy`, `sandbox`, or `full-control` is specified by CLI, environment,
or config, the backend locks that policy and browser requests cannot override it.
Codex approval requests are surfaced in the UI approval tray and answered
through the authenticated `/api/client-requests/respond` endpoint.

## Configuration

The CLI loads JSON config in this order:

1. `--config <path>` / `-c <path>`
2. `./codex-webgui.json`
3. `~/.codex-webgui/codex-webgui.json`
4. `~/.codex-webgui/config.json`

CLI options override environment variables; environment variables override the
config file; the config file overrides defaults.

Example `codex-webgui.json`:

```json
{
  "host": "127.0.0.1",
  "port": 4545,
  "password": "change-me",
  "appServerSocket": "~/.codex-webgui/codex-app-server.sock",
  "cwd": "/path/to/project",
  "model": "gpt-5.5",
  "reasoningEffort": "high",
  "approvalPolicy": "on-request",
  "sandbox": "workspace-write",
  "unsafePermissions": false,
  "dataDir": "~/.codex-webgui/data",
  "uploadDir": "~/.codex-webgui/data/uploads",
  "allowedOrigins": "http://localhost:*,http://127.0.0.1:*"
}
```

To opt into full local control from config, use either:

```json
{
  "host": "0.0.0.0",
  "password": "change-me",
  "permissions": "full-control"
}
```

Full control is intentionally broad: it starts future turns with
`approvalPolicy: "never"` and `sandbox: "danger-full-access"`. A turn that was
already active before the change can still surface approval requests because
Codex received its approval policy when that turn started.

Prefer `CODEX_WEB_UI_PASSWORD` and `CODEX_WEB_UI_AUTH_SECRET` environment
variables for secrets instead of storing them in the config file.

## Security and Tunnels

Treat the Web UI as local developer tooling, not as a hardened public service.
Authenticated users can start Codex turns, browse and download files visible to
the configured Codex cwd, upload attachments, and approve actions according to
the configured Codex approval and sandbox policy.

Before binding to `0.0.0.0`, using a LAN address, or exposing the port through
ngrok, cloudflared, a reverse proxy, or another tunnel:

- Set a strong `CODEX_WEB_UI_PASSWORD`.
- Set a separate random `CODEX_WEB_UI_AUTH_SECRET` so JWT signing does not
  depend on the password value.
- Keep `CODEX_WEB_UI_ALLOWED_ORIGINS` limited to the exact local, LAN, or
  tunnel origins you use.
- Prefer HTTPS for any non-localhost access. Browser microphone and
  screen-capture permissions require HTTPS, localhost, or another secure browser
  context, and remote MCP OAuth login generally needs an HTTPS Web UI origin.
- Avoid `--full-control`, `--unsafe-permissions`, `danger-full-access`, and
  `approvalPolicy=never` unless the server is only reachable by people who
  should have command execution access to the selected workspace.

The password gate is intentionally simple and server-side. For real internet
exposure, put this behind HTTPS, use strong secrets, and restrict allowed
origins to origins you actually use.

## Persistence

The server writes:

- `server.jsonl` under `CODEX_WEB_UI_DATA_DIR`.
- `sessions/<thread-id>.jsonl` under `CODEX_WEB_UI_DATA_DIR`.
- `sessions.json` under `CODEX_WEB_UI_DATA_DIR`.
- Uploaded files under `CODEX_WEB_UI_UPLOAD_DIR`.
- A managed app-server socket at `CODEX_APP_SERVER_SOCKET`.
- Managed app-server PID and log files beside the socket.

The browser also stores the 4-hour bearer token and UI layout preferences in
`localStorage`.

The server is protected by password auth. Login exchanges
`CODEX_WEB_UI_PASSWORD` for a 4-hour bearer JWT stored by the browser in
localStorage and sent as an `Authorization` header. With no password configured
on a loopback host, the CLI generates and prints a temporary local password for
that process. With no password on a non-loopback host, startup refuses to bind.

Default npm install paths are:

- Config: `~/.codex-webgui/config.json`.
- Runtime data: `~/.codex-webgui/data`.
- Uploads: `~/.codex-webgui/data/uploads`.
- App-server socket: `~/.codex-webgui/codex-app-server.sock`.
- App-server PID/log files: `~/.codex-webgui/codex-app-server.pid` and
  `~/.codex-webgui/codex-app-server.log`.

To stop the managed sidecar and remove Codex Web UI runtime files:

```bash
codex-web-ui app-server stop
rm -rf ~/.codex-webgui/data
rm -f ~/.codex-webgui/codex-app-server.sock ~/.codex-webgui/codex-app-server.pid ~/.codex-webgui/codex-app-server.log
```

To remove the starter config as well:

```bash
rm -f ~/.codex-webgui/config.json ~/.codex-webgui/codex-webgui.json
rmdir ~/.codex-webgui 2>/dev/null || true
```

These cleanup commands do not remove `~/.codex`, Codex login credentials,
Codex's own session history, or files in your project workspaces. Clear the
browser's site data for the Web UI origin to remove the localStorage token,
layout preferences, saved drafts, and per-thread permission overrides.

For development, run Next directly:

```bash
npm run dev
```

Security regression tests cover the API auth boundary and file-explorer path
containment:

```bash
npm run test:security
```

For the full local service, run the Codex app-server sidecar as a separate
process. This keeps the Codex app-server out of npm lifecycle watchers and
leaves PID/log files beside the configured socket. Next talks to the sidecar
through the Unix socket in `CODEX_APP_SERVER_SOCKET`.

Start the sidecar:

```bash
npm run app-server:start
npm run app-server:status
```

Then build and run Next against that socket:

```bash
kill "$(cat tmp/backend.pid)" 2>/dev/null || true
npm run build
CODEX_WEB_UI_PASSWORD='change-me' npm start
```

Do not run `next build` while `next start` is serving the same `.next`
directory; stop the backend first, then rebuild and restart it.

Sidecar commands:

```bash
npm run app-server:start
npm run app-server:stop
npm run app-server:restart
npm run app-server:recover
npm run app-server:status
```

`app-server:recover` treats a live PID without a connectable socket as
degraded, restarts the sidecar, and waits until the Unix socket accepts
connections. Use it when the UI reports `connect ENOENT ...codex-app-server.sock`.

For MCP OAuth from a phone or another machine, Codex Web UI relays OAuth
callbacks through the currently used Web UI origin. When an MCP OAuth login
starts, the backend updates Codex's callback config to:

```toml
mcp_oauth_callback_port = 33420
mcp_oauth_callback_url = "http://<web-ui-origin>/api/mcp/oauth/callback"
```

The callback route keeps valid callback path/state pairs in memory, forwards a
matching callback once to Codex's local listener, and rejects expired, unknown,
or repeated callbacks. OAuth providers generally reject plain HTTP redirects
except for localhost, so remote or LAN OAuth login requires an HTTPS Web UI
origin. Behind a reverse proxy, set `CODEX_WEB_UI_PUBLIC_ORIGIN` if
`X-Forwarded-Proto` and `X-Forwarded-Host` are not enough to reconstruct the
public origin. Set `CODEX_WEB_UI_MCP_OAUTH_CALLBACK_PORT` to change the local
Codex callback listener port.

To expose the running server through ngrok:

```bash
ngrok http 4545
```

Useful environment variables:

```bash
CODEX_WEB_UI_PASSWORD='change-me' HOST=127.0.0.1 PORT=4545 npm start
CODEX_WEB_UI_ALLOWED_ORIGINS='http://localhost:*,http://127.0.0.1:*,https://example-tunnel.example.com' npm start
CODEX_WEB_UI_ALLOWED_DEV_ORIGINS='192.168.1.66' npm run dev
CODEX_WEB_UI_AUTH_SECRET='separate-token-signing-secret' npm start
CODEX_COMMAND=codex CODEX_CWD=/path/to/project npm start
CODEX_MODEL=gpt-5.5 CODEX_REASONING_EFFORT=high npm start
CODEX_WEB_UI_APPROVAL_POLICY=on-request CODEX_WEB_UI_SANDBOX=workspace-write npm start
CODEX_WEB_UI_UNSAFE_PERMISSIONS=1 CODEX_WEB_UI_SANDBOX=danger-full-access npm start
CODEX_APP_SERVER_SOCKET=/path/to/codex-app-server.sock npm start
CODEX_WEB_UI_EXTERNAL_APP_SERVER=1 CODEX_APP_SERVER_SOCKET=/path/to/codex-app-server.sock npm start
CODEX_WEB_UI_DATA_DIR=/path/to/logs npm start
```

Next loads `.env` from the project root before reading these variables. Shell environment variables still win over `.env`.

## Features

- Lists active, archived, and previously logged Codex sessions.
- Starts, loads, renames, forks, archives, unarchives, and compacts sessions.
- Starts new turns, steers active turns, and interrupts active turns.
- Streams app-server notifications and stderr via SSE.
- Writes backend JSONL logs to `data/server.jsonl` and `data/sessions/<thread-id>.jsonl`; RPC request/response logs keep summary metadata instead of full payloads.
- Shows file-backed session history in the frontend.
- Renders turns, reasoning, user/agent markdown, commands, command output, file changes, diffs, file references, and tool calls, with AI Elements primitives for the composer, confirmations, terminal output, code blocks, and file tree.
- Uploads file attachments and inserts uploaded paths into the composer.
- Previews referenced text, code, Markdown, JSON, images, PDFs, and browser-playable video files.
- Shows app-server status and account rate-limit usage.
