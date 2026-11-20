import { describe, expect, it } from "vitest";

import {
  BACKUP_RETRY_MS,
  backupDue,
  backupOverdue,
  backupTime,
  lastScheduledAt,
  nextScheduledAt,
} from "./backup-schedule";

// Pakistan is UTC+5 all year: 7 pm there is 14:00 UTC.
const pk = (iso: string) => new Date(`${iso}+05:00`);

describe("backup schedule", () => {
  it("reads the time, falling back to 7 pm", () => {
    expect(backupTime("21:30")).toBe("21:30");
    expect(backupTime("7pm")).toBe("19:00");
    expect(backupTime("24:00")).toBe("19:00");
    expect(backupTime(null)).toBe("19:00");
  });

  it("finds the last and next 7 pm in Pakistan time", () => {
    expect(lastScheduledAt(pk("2026-11-20T20:15:00"), "19:00").toISOString()).toBe(
      "2026-11-20T14:00:00.000Z",
    );
    // Before 7 pm: yesterday's.
    expect(lastScheduledAt(pk("2026-11-20T09:00:00"), "19:00").toISOString()).toBe(
      "2026-11-19T14:00:00.000Z",
    );
    // Exactly 7 pm counts as today's.
    expect(lastScheduledAt(pk("2026-11-20T19:00:00"), "19:00").toISOString()).toBe(
      "2026-11-20T14:00:00.000Z",
    );
    // Across a month end.
    expect(lastScheduledAt(pk("2026-12-01T08:00:00"), "19:00").toISOString()).toBe(
      "2026-11-30T14:00:00.000Z",
    );
    expect(nextScheduledAt(pk("2026-11-20T09:00:00"), "19:00").toISOString()).toBe(
      "2026-11-20T14:00:00.000Z",
    );
    expect(nextScheduledAt(pk("2026-11-20T20:00:00"), "19:00").toISOString()).toBe(
      "2026-11-21T14:00:00.000Z",
    );
  });

  it("runs once a day at the time, and catches up a missed day as soon as it can", () => {
    const due = (now: string, lastBackupAt: string | null, lastErrorAt: string | null = null) =>
      backupDue({ now: pk(now), time: "19:00", lastBackupAt, lastErrorAt });
    const at = (iso: string) => pk(iso).toISOString();

    // Backed up yesterday evening: nothing until 7 pm today, then due.
    expect(due("2026-11-20T18:59:00", at("2026-11-19T19:01:00"))).toBe(false);
    expect(due("2026-11-20T19:00:00", at("2026-11-19T19:01:00"))).toBe(true);
    // Done at 7:01 pm: not again today.
    expect(due("2026-11-20T23:00:00", at("2026-11-20T19:01:00"))).toBe(false);
    // Laptop was off at 7 pm yesterday: due the moment it is on in the morning.
    expect(due("2026-11-21T09:00:00", at("2026-11-19T19:01:00"))).toBe(true);
    // Never backed up: due.
    expect(due("2026-11-20T10:00:00", null)).toBe(true);
  });

  it("waits after a failed try instead of trying every minute", () => {
    const now = pk("2026-11-20T19:30:00");
    const base = { now, time: "19:00", lastBackupAt: pk("2026-11-19T19:01:00").toISOString() };
    const failedAgo = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(backupDue({ ...base, lastErrorAt: failedAgo(5 * 60_000) })).toBe(false);
    expect(backupDue({ ...base, lastErrorAt: failedAgo(BACKUP_RETRY_MS) })).toBe(true);
    // An old failure from before the last good backup does not hold it back.
    expect(backupDue({ ...base, lastErrorAt: pk("2026-11-19T10:00:00").toISOString() })).toBe(true);
  });

  it("warns once a whole scheduled backup has been missed", () => {
    const overdue = (now: string, last: string | null) =>
      backupOverdue({ now: pk(now), time: "19:00", lastBackupAt: last && pk(last).toISOString() });
    expect(overdue("2026-11-20T20:00:00", "2026-11-19T19:05:00")).toBe(false); // today's is just late
    expect(overdue("2026-11-21T09:00:00", "2026-11-19T19:05:00")).toBe(false); // catching up now
    expect(overdue("2026-11-21T20:00:00", "2026-11-19T19:05:00")).toBe(true); // two 7 pms missed
    expect(overdue("2026-11-20T10:00:00", null)).toBe(true);
  });
});
