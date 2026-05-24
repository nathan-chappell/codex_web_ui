# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4545 \
    CODEX_WEB_UI_DATA_DIR=/home/node/.codex-webgui/data \
    CODEX_WEB_UI_UPLOAD_DIR=/home/node/.codex-webgui/data/uploads \
    CODEX_APP_SERVER_SOCKET=/home/node/.codex-webgui/codex-app-server.sock

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @openai/codex \
  && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/.next ./.next
COPY --from=build /app/app ./app
COPY --from=build /app/bin ./bin
COPY --from=build /app/client ./client
COPY --from=build /app/components ./components
COPY --from=build /app/lib ./lib
COPY --from=build /app/server ./server
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=build /app/tsconfig.json ./tsconfig.json

RUN mkdir -p /home/node/.codex /home/node/.codex-webgui/data/uploads \
  && chown -R node:node /app /home/node/.codex /home/node/.codex-webgui

USER node
EXPOSE 4545
VOLUME ["/home/node/.codex", "/home/node/.codex-webgui"]

ENTRYPOINT ["node", "./bin/codex-web-ui.js"]
CMD ["--host", "0.0.0.0"]
