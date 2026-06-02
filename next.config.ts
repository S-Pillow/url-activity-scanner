import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Assumption A-AIPF009-01 — No framework extensions needed for MVP.

  // basePath scopes all pages, API routes, and static asset paths under
  // /tools/url-activity-scanner so that a single nginx location block
  // `location ^~ /tools/url-activity-scanner/` captures the page, the API,
  // and all /_next/ static assets without conflict with the ForgeForward SPA
  // or the job-tracker Next.js app (which uses /tools/job-tracker as its basePath).
  //
  // Page route `/`  → served at /tools/url-activity-scanner/
  // API route `/api/scan` → served at /tools/url-activity-scanner/api/scan
  // Static assets   → served at /tools/url-activity-scanner/_next/static/…
  basePath: "/tools/url-activity-scanner",

  // Silences "multiple lockfiles detected" warning from Turbopack.
  // The workspace has a root-level package-lock.json (unrelated project)
  // alongside this project's own lockfile. Pinning the root explicitly
  // ensures Next.js/Turbopack resolves modules from this project only.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
