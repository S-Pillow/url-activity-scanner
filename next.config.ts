import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Assumption A-AIPF009-01 — No framework extensions needed for MVP.
  // The scanner makes only server-side API calls from route.ts; the client
  // only calls /api/tools/url-activity-scanner. No rewrites, redirects,
  // or runtime configuration changes are required for the prototype.

  // Silences "multiple lockfiles detected" warning from Turbopack.
  // The workspace has a root-level package-lock.json (unrelated project)
  // alongside this project's own lockfile. Pinning the root explicitly
  // ensures Next.js/Turbopack resolves modules from this project only.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
