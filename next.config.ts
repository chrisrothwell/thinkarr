import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "winston", "winston-daily-rotate-file"],
};

export default nextConfig;
