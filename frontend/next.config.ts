import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Keep Turbopack scoped to this app so production builds don't walk up to
    // unrelated lockfiles outside the repo.
    root: process.cwd(),
  },
};

export default nextConfig;
