import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

const certPath = path.resolve("tmp/dev-cert.pem");
const keyPath = path.resolve("tmp/dev-key.pem");
const https = existsSync(certPath) && existsSync(keyPath)
  ? {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath)
    }
  : undefined;

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../dist/public",
    emptyOutDir: true
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    https,
    proxy: {
      "/api": "http://127.0.0.1:4545"
    }
  }
});
