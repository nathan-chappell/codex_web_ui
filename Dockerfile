# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS runtime
ARG CODEX_WEB_UI_NPM_SPEC=codex-web-ui@latest

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4545 \
    CODEX_WEB_UI_DATA_DIR=/home/node/.codex-webgui/data \
    CODEX_WEB_UI_UPLOAD_DIR=/home/node/.codex-webgui/data/uploads \
    CODEX_APP_SERVER_SOCKET=/home/node/.codex-webgui/codex-app-server.sock

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @openai/codex "${CODEX_WEB_UI_NPM_SPEC}" \
  && npm cache clean --force

RUN mkdir -p /home/node/.codex /home/node/.codex-webgui/data/uploads \
  && chown -R node:node /home/node/.codex /home/node/.codex-webgui

USER node
EXPOSE 4545
VOLUME ["/home/node/.codex", "/home/node/.codex-webgui"]

ENTRYPOINT ["codex-web-ui"]
CMD ["--host", "0.0.0.0"]
