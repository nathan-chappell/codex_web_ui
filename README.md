# Codex Web UI

TypeScript web UI for controlling `codex app-server` remotely.

This project does not reimplement Codex. It is a client/UI layer over the
official `codex app-server`.

Status: workaround / experimental.

Target: Linux/Ubuntu users who want a mobile-friendly Codex UI before an
official Linux Codex app exists.

The app is a Next.js App Router application with Tailwind, shadcn/ui, and AI Elements components. UI routes live under `/threads` and `/thread/[threadId]`; API endpoints are implemented as Next route handlers under `/api`.

## Run

```bash
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4545`.

## CLI

The npm package exposes a `codex-web-ui` command:

```bash
codex-web-ui --help
codex-web-ui --port 4545
CODEX_WEB_UI_PASSWORD='change-me' codex-web-ui --host 0.0.0.0
CODEX_WEB_UI_PASSWORD='change-me' codex-web-ui --host 0.0.0.0 --full-control
codex-web-ui --app-server-socket "$PWD/tmp/codex-app-server.sock" --model gpt-5.5 --effort high
codex-web-ui --config ./codex-webgui.json
```

By default the CLI binds to `127.0.0.1:4545`. Binding to a non-loopback host
requires `CODEX_WEB_UI_PASSWORD` or `--password`; this is intentional because
the app can read local files through authenticated preview/download endpoints.

For source or git installs, run `codex-web-ui --build` once if the package does
not include a `.next` production build.

The CLI uses these directory defaults:

- Next app cwd: the package install directory.
- Codex cwd: the current working directory where `codex-web-ui` was launched.
- Runtime data: `~/.codex-webgui/data`.
- Uploads: `~/.codex-webgui/data/uploads`.

Useful CLI options:

```bash
codex-web-ui \
  --host 127.0.0.1 \
  --port 4545 \
  --app-server-socket "$PWD/tmp/codex-app-server.sock" \
  --cwd /path/to/project \
  --model gpt-5.5 \
  --effort high \
  --approval-policy on-request \
  --sandbox workspace-write \
  --data-dir "$PWD/data"
```

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
  "appServerSocket": "./tmp/codex-app-server.sock",
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

## Persistence

The server writes:

- `server.jsonl` under `CODEX_WEB_UI_DATA_DIR`.
- `sessions/<thread-id>.jsonl` under `CODEX_WEB_UI_DATA_DIR`.
- `sessions/index.json` under `CODEX_WEB_UI_DATA_DIR`.
- Uploaded files under `CODEX_WEB_UI_UPLOAD_DIR`.

The browser also stores the 4-hour bearer token and UI layout preferences in
`localStorage`.

The server is protected by password auth. Login exchanges
`CODEX_WEB_UI_PASSWORD` for a 4-hour bearer JWT stored by the browser in
localStorage and sent as an `Authorization` header. With no password configured,
login remains locked and API routes stay unauthorized.

For development, run Next directly:

```bash
npm run dev
```

For the full local service, run the Codex app-server sidecar as a separate
process. This keeps the Codex app-server out of npm lifecycle watchers and
leaves PID/log files under `tmp/`. Next talks to the sidecar through the Unix
socket in `CODEX_APP_SERVER_SOCKET`.

Start the sidecar:

```bash
npm run app-server:start
npm run app-server:status
```

Then build and run Next against that socket:

```bash
kill "$(cat tmp/backend.pid)" 2>/dev/null || true
npm run build
CODEX_APP_SERVER_SOCKET="$PWD/tmp/codex-app-server.sock" CODEX_WEB_UI_PASSWORD='change-me' npm start
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

To expose the running server through ngrok:

```bash
ngrok http 4545
```

Set a strong `CODEX_WEB_UI_PASSWORD` before exposing the server to the internet.

Useful environment variables:

```bash
CODEX_WEB_UI_PASSWORD='change-me' HOST=127.0.0.1 PORT=4545 npm start
CODEX_WEB_UI_ALLOWED_ORIGINS='http://localhost:*,http://127.0.0.1:*,http://192.168.1.66:*,https://manifesto-tank-reliance.ngrok-free.dev' npm start
CODEX_WEB_UI_AUTH_SECRET='separate-token-signing-secret' npm start
CODEX_COMMAND=codex CODEX_CWD=/path/to/project npm start
CODEX_MODEL=gpt-5.5 CODEX_REASONING_EFFORT=high npm start
CODEX_WEB_UI_APPROVAL_POLICY=on-request CODEX_WEB_UI_SANDBOX=workspace-write npm start
CODEX_WEB_UI_UNSAFE_PERMISSIONS=1 CODEX_WEB_UI_SANDBOX=danger-full-access npm start
CODEX_APP_SERVER_SOCKET=/path/to/codex-app-server.sock npm start
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

The password gate is intentionally simple and server-side. For real internet exposure, put this behind HTTPS, set a strong `CODEX_WEB_UI_PASSWORD`, and restrict `CODEX_WEB_UI_ALLOWED_ORIGINS` to origins you actually use.
