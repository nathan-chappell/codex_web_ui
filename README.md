# Codex Web UI

TypeScript web UI for controlling `codex app-server` remotely.

The backend is a small Node HTTP/SSE server. The frontend is a Vite React TS app that builds into `dist/public` and is served by the backend.

## Run

```bash
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4545`. The hardcoded fallback password is `codex`.

To expose the running server through ngrok:

```bash
ngrok http 4545
```

Set a strong `CODEX_WEB_UI_PASSWORD` before exposing the server to the internet.

Useful environment variables:

```bash
CODEX_WEB_UI_PASSWORD='change-me' PORT=4545 HOST=0.0.0.0 npm start
CODEX_COMMAND=codex CODEX_CWD=/path/to/project npm start
CODEX_MODEL=gpt-5.5 CODEX_REASONING_EFFORT=high npm start
CODEX_WEB_UI_DATA_DIR=/path/to/logs npm start
```

The backend loads `.env` from the project root before reading these variables. Shell environment variables still win over `.env`.

## Features

- Lists active, archived, and previously logged Codex sessions.
- Starts, loads, renames, forks, archives, unarchives, compacts, and rolls back sessions.
- Starts new turns, steers active turns, and interrupts active turns.
- Streams app-server notifications and stderr via SSE.
- Writes backend JSONL logs to `data/server.jsonl` and `data/sessions/<thread-id>.jsonl`.
- Shows file-backed session history in the frontend.
- Renders turns, reasoning, user/agent markdown, commands, command output, file changes, and tool calls.
- Includes a raw JSON-RPC panel for app-server methods that do not have first-class controls yet.

The password gate is intentionally simple and server-side. For real internet exposure, put this behind HTTPS and set a strong `CODEX_WEB_UI_PASSWORD`.
