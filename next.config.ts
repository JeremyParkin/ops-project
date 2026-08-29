import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // CSV import (Phase 8C.2) re-sends the parsed file's row data across a few
  // Server Action calls (upload -> preflight -> commit); the 1MB default is
  // too small for the 5MB app-level file cap plus that round-trip overhead.
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
