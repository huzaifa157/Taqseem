import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

/**
 * Every Node function on Vercel starts with next/setup-node-env, which loads node-environment,
 * require-hook and node-polyfill-crypto (and about 50 files they load). Next 16.4's Vercel adapter
 * adds those files itself only for webpack builds ("Turbopack traces these itself"), but Turbopack
 * leaves them out of the route traces, so every route crashed at start ("Cannot find module
 * 'next/dist/server/node-environment'", then "'../patch-error-inspect'"). Trace that startup file
 * with Next's own tracer at build time and ship everything it needs with every route: no
 * hand-kept list, so a Next.js update cannot leave a file behind. The proxy (middleware) trace
 * already has it. Paths are the real pnpm ones (node_modules/.pnpm/next@…/).
 */
const LAUNCHER_LOADS = ["dist/build/adapter/setup-node-env.external.js"];

async function nodeEnvironmentFiles(): Promise<string[]> {
  const root = process.cwd();
  const { nodeFileTrace } = (await import(
    /* turbopackIgnore: true */ join(root, "node_modules/next/dist/compiled/@vercel/nft/index.js")
  )) as {
    nodeFileTrace: (files: string[], opts: { base: string }) => Promise<{ fileList: Set<string> }>;
  };
  const next = realpathSync(join(root, "node_modules/next"));
  const entries = LAUNCHER_LOADS.map((f) => join(next, f));
  const { fileList } = await nodeFileTrace(entries, { base: root });
  const files = [...fileList]
    .map((f) => relative(root, join(root, f)).split(sep).join("/"))
    .filter((f) => f !== "package.json")
    // The pnpm folder ("next@16.4.3_@babel+core@…", hashed on Windows, long on Linux) as a
    // wildcard: Turbopack applies these includes itself, and on Vercel only this form arrived
    // (literal folder names were silently left out).
    .map((f) => `./${f.replace(/\.pnpm\/((?:@[^+/]+\+)?[^@/]+)@[^/]+\//g, ".pnpm/$1@*/")}`);
  console.log(`Vercel startup files: ${files.length} added to every route`);
  return files;
}

export default async function config(phase: string): Promise<NextConfig> {
  return {
    // The Windows installer (scripts/windows/package.ps1) ships the self-contained server; normal
    // `next start` (taqseem.bat, development) does not use it.
    // It builds into its own folder, so packaging never touches the build a running website uses.
    ...(process.env.TAQSEEM_STANDALONE
      ? { output: "standalone" as const, distDir: ".next-package" }
      : {}),
    // No outputFileTracingExcludes: Turbopack matches those patterns anywhere in a path, so
    // "dist/**" (meant for our installer folder) also dropped node_modules/next/dist on Linux, and
    // every Vercel function crashed on a missing Next.js file. Windows paths use backslashes, so it
    // never showed there. The run-time file lookups (cloud sync: migrations, pg_dump) carry
    // turbopackIgnore, so the tracing does not pull dist/, docs/ or backups in anyway.
    // Only for a production build: `next dev` does not trace files.
    ...(phase === PHASE_PRODUCTION_BUILD
      ? await (async () => {
          const files = await nodeEnvironmentFiles();
          // Applied to every page and API route (Next does not apply it to the proxy).
          return { outputFileTracingIncludes: { "/**": files } };
        })()
      : {}),
    cacheComponents: true,
    partialPrefetching: true,
    experimental: {
      // Excel/CSV imports go through server actions; files are limited to 2 MB in the app.
      serverActions: { bodySizeLimit: "3mb" },
      // The installer is built on an office laptop (8 GB): one build worker per core (11 here)
      // ran it out of memory while collecting page data. Two are enough and fit.
      ...(process.env.TAQSEEM_STANDALONE ? { cpus: 2 } : {}),
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
}
