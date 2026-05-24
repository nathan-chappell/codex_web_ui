import type { NextConfig } from "next";

const allowedDevOrigins = (process.env.CODEX_WEB_UI_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
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
