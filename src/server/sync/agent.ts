import { join } from "node:path";

import { type ScheduledResult, syncIfDue, syncOnce, type SyncResult } from "./engine";

// The background backup loop, inside the website's server process. Every minute it asks the engine
// whether the daily backup is due (syncIfDue: a quick look at this computer's database only); the
// cloud database is contacted just once a day, at the backup time, or as soon as possible after a
// missed one. "Back up now" runs at once (syncNow). Nothing at all while cloud sync is off.
// Started once from instrumentation.ts. The installer sets PG_BIN (its pgsql\bin) and
// TAQSEEM_MIGRATIONS_DIR; in development the migrations are prisma/migrations and pg_dump comes
// from PATH.

const CHECK_EVERY_MS = 60_000;

type AgentState = {
  timer?: NodeJS.Timeout;
  running?: Promise<SyncResult | ScheduledResult>;
  started?: boolean;
};
const g = globalThis as typeof globalThis & { __taqseemSync?: AgentState };
const state: AgentState = (g.__taqseemSync ??= {});

function options() {
  const localUrl = process.env.DATABASE_URL;
  if (!localUrl) return null;
  return {
    localUrl,
    migrationsDir:
      process.env.TAQSEEM_MIGRATIONS_DIR ??
      join(/* turbopackIgnore: true */ process.cwd(), "prisma", "migrations"),
    pgBin: process.env.PG_BIN,
  };
}

/** One run at a time: the run already going, or `start` now. */
function single<T extends SyncResult | ScheduledResult>(start: () => Promise<T>): Promise<T> {
  if (state.running) return state.running as Promise<T>;
  const run = start()
    .catch((error): T => ({ status: "error", message: String(error) }) as T)
    .finally(() => {
      state.running = undefined;
    });
  state.running = run;
  return run;
}

/** "Back up now": a full run straight away (or the one already running). */
export async function syncNow(): Promise<SyncResult> {
  const o = options();
  if (!o) return { status: "off" };
  const result = await single<ScheduledResult>(() => syncOnce(o));
  // A scheduled check that was already going is not a backup: run one now.
  return result.status === "waiting" ? single(() => syncOnce(o)) : result;
}

function schedule(ms: number) {
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    const o = options();
    if (o) await single(() => syncIfDue(o));
    schedule(CHECK_EVERY_MS);
  }, ms);
  state.timer.unref?.();
}

export function startSyncAgent() {
  if (state.started || !options()) return;
  state.started = true;
  schedule(5_000);
}
