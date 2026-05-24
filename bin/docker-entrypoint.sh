#!/bin/sh
set -eu

codex-web-ui app-server start --socket "${CODEX_APP_SERVER_SOCKET:-/home/node/.codex-webgui/codex-app-server.sock}"
exec codex-web-ui "$@"
