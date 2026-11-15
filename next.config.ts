import type { NextConfig } from "next";

/** Project folders the server never needs at run time (matched from the project root). */
const TRACE_EXCLUDES = ["dist/**", ".backups/**", "test/**", "docs/**"];

const nextConfig: NextConfig = {
  // The Windows installer (scripts/windows/package.ps1) ships the self-contained server; normal
  // `next start` (taqseem.bat, development) does not use it.
  // It builds into its own folder, so packaging never touches the build a running website uses.
  ...(process.env.TAQSEEM_STANDALONE
    ? { output: "standalone" as const, distDir: ".next-package" }
    : {}),
  // The cloud sync looks up files at run time (migrations, pg_dump); never let the file tracing
  // pull downloads or old installers into the package. Never list .next or .next-package here:
  // the build's own server chunks live there, and the package then misses them (ChunkLoadError).
  // Keyed by route ("/**") and the instrumentation entry, never "*": Next.js also applies a "*" list
  // to its own server files, matching anywhere in a path, so "dist/**" would hit node_modules/next/dist.
  outputFileTracingExcludes: {
    "/**": TRACE_EXCLUDES,
    instrumentation: TRACE_EXCLUDES,
  },
  // Vercel's launcher loads next/dist/server/node-environment before the server, but Next 16.4's
  // minimal server trace leaves that file out, so every function crashed at start ("Cannot find
  // module 'next/dist/server/node-environment'"). Ship it, and what it loads, with every route.
  // The real pnpm path: the launcher resolves it from inside node_modules/.pnpm/next@*/.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/.pnpm/next@*/node_modules/next/dist/server/node-environment*.js",
      "./node_modules/.pnpm/next@*/node_modules/next/dist/server/node-environment-extensions/*.js",
    ],
  },
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Excel/CSV imports go through server actions; files are limited to 2 MB in the app.
    serverActions: { bodySizeLimit: "3mb" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
