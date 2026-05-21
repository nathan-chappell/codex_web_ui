# Codex Web UI

TypeScript web UI for controlling `codex app-server` remotely.

The backend is a small Node HTTP/SSE server. The frontend is a Next/Tailwind React app with shadcn/ui and AI Elements components. `npm run build:client` exports it statically, copies it into `dist/public`, and the backend serves that artifact.

## Run

```bash
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4545`.

The server is protected by password auth. Login exchanges
`CODEX_WEB_UI_PASSWORD` for a 4-hour bearer JWT stored by the browser in
localStorage and sent as an `Authorization` header. With no password configured,
login remains locked and API routes stay unauthorized.

For development, run the backend, Next dev server, and a sibling Codex app-server process:

```bash
CODEX_WEB_UI_PASSWORD='change-me' HOST=0.0.0.0 npm run dev
```

In dev mode, the backend connects directly to the sibling app-server over
`CODEX_APP_SERVER_SOCKET` instead of owning the app-server process. That lets
backend watch restarts reconnect without terminating active Codex work.

For local watch mode without the Next dev server, rebuild the exported frontend
on change and restart the backend on server changes:

```bash
CODEX_WEB_UI_PASSWORD='change-me' HOST=0.0.0.0 PORT=4545 npm run watch
```

This serves the rebuilt frontend from `dist/public`, keeps a sibling
`codex app-server` process running, and reconnects the backend to the socket
after backend restarts.

You can also run the pieces manually:

```bash
CODEX_APP_SERVER_SOCKET=./tmp/codex-app-server.sock npm run codex:app-server
CODEX_APP_SERVER_SOCKET=./tmp/codex-app-server.sock CODEX_WEB_UI_PASSWORD='change-me' HOST=0.0.0.0 npm run dev:api
npm run dev:client
```

To expose the running server through ngrok:

```bash
ngrok http 4545
```

Set a strong `CODEX_WEB_UI_PASSWORD` before exposing the server to the internet.

Useful environment variables:

```bash
CODEX_WEB_UI_PASSWORD='change-me' PORT=4545 HOST=0.0.0.0 npm start
CODEX_WEB_UI_ALLOWED_ORIGINS='http://localhost:*,http://127.0.0.1:*,http://192.168.1.66:*,https://manifesto-tank-reliance.ngrok-free.dev' npm start
CODEX_WEB_UI_AUTH_SECRET='separate-token-signing-secret' npm start
CODEX_COMMAND=codex CODEX_CWD=/path/to/project npm start
CODEX_MODEL=gpt-5.5 CODEX_REASONING_EFFORT=high npm start
CODEX_APP_SERVER_SOCKET=/path/to/codex-app-server.sock npm start
CODEX_WEB_UI_DATA_DIR=/path/to/logs npm start
```

The backend loads `.env` from the project root before reading these variables. Shell environment variables still win over `.env`.

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
