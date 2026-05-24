import type { NextConfig } from "next";

const allowedDevOrigins = (process.env.CODEX_WEB_UI_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
  outputFileTracingExcludes: {
    "/api/**": [
      "./*.md",
      "./*.tsbuildinfo",
      "./.git/**/*",
      "./app/**/*",
      "./bin/**/*",
      "./client/**/*",
      "./components/**/*",
      "./components.json",
      "./coverage/**/*",
      "./data/**/*",
      "./dist/**/*",
      "./Dockerfile",
      "./lib/**/*",
      "./LICENSE",
      "./next.config.ts",
      "./package*.json",
      "./playwright-report/**/*",
      "./playwright.config.ts",
      "./postcss.config.mjs",
      "./server/**/*",
      "./test-results/**/*",
      "./tests/**/*",
      "./tmp/**/*",
      "./tsconfig*.json"
    ]
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Permissions-Policy",
            value: "microphone=(self)"
          }
        ]
      }
    ];
  },
  images: {
    unoptimized: true
  },
  reactStrictMode: true,
};

export default nextConfig;
