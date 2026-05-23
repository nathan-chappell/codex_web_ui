import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.1.66"],
  images: {
    unoptimized: true
  },
  reactStrictMode: true,
};

export default nextConfig;
