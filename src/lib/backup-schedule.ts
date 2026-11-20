// When the daily cloud backup runs (Settings → Cloud sync). Pure, so it is unit-tested.
//
// The backup runs once a day at a set time (7 pm by default) in the business's time zone. If the
// computer is off or offline then, it runs as soon as it can afterwards: a backup is due whenever
// the last good one is older than the most recent scheduled time. A failed try waits a while
// before the next, so a day without internet does not mean a try every minute.

export const DEFAULT_BACKUP_TIME = "19:00";
export const BACKUP_TIME_ZONE = "Asia/Karachi";
/** After a failed backup (no internet), wait this long before trying again. */
export const BACKUP_RETRY_MS = 15 * 60_000;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "19:00" style, 24-hour; anything else falls back to the default. */
export function backupTime(value: string | null | undefined): string {
  return value && TIME.test(value) ? value : DEFAULT_BACKUP_TIME;
}

export const isBackupTime = (value: string) => TIME.test(value);

/** Milliseconds the time zone's wall clock is ahead of UTC at `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const wall = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant the wall clock in `timeZone` shows `time` on the given calendar day. */
function atWallTime(year: number, month: number, day: number, time: string, timeZone: string) {
  const [h, m] = backupTime(time).split(":").map(Number) as [number, number];
  const guess = Date.UTC(year, month, day, h, m);
  return new Date(guess - zoneOffsetMs(new Date(guess), timeZone));
}

/** The most recent scheduled backup time at or before `now` (today's, or yesterday's). */
export function lastScheduledAt(now: Date, time: string, timeZone = BACKUP_TIME_ZONE): Date {
  const local = new Date(now.getTime() + zoneOffsetMs(now, timeZone));
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  const today = atWallTime(y, mo, d, time, timeZone);
  return today <= now ? today : atWallTime(y, mo, d - 1, time, timeZone);
}

/** The next scheduled backup time after `now`. */
export function nextScheduledAt(now: Date, time: string, timeZone = BACKUP_TIME_ZONE): Date {
  const last = lastScheduledAt(now, time, timeZone);
  const local = new Date(last.getTime() + zoneOffsetMs(last, timeZone));
  return atWallTime(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
    time,
    timeZone,
  );
}

const time = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null);

/**
 * Whether the backup should run now: the last good backup is older than the most recent scheduled
 * time (so a missed day is caught up as soon as possible), and no failed try in the last
 * BACKUP_RETRY_MS.
 */
export function backupDue(s: {
  now: Date;
  time: string;
  lastBackupAt: string | null | undefined;
  lastErrorAt: string | null | undefined;
  timeZone?: string;
}): boolean {
  const slot = lastScheduledAt(s.now, s.time, s.timeZone).getTime();
  const backup = time(s.lastBackupAt);
  if (backup !== null && backup >= slot) return false;
  const error = time(s.lastErrorAt);
  const failedSince = error !== null && (backup === null || error > backup);
  return !(failedSince && s.now.getTime() - error! < BACKUP_RETRY_MS);
}

/**
 * Worth a warning: a whole scheduled backup has been missed (the last good one is older than the
 * scheduled time before the most recent), e.g. no internet for days.
 */
export function backupOverdue(s: {
  now: Date;
  time: string;
  lastBackupAt: string | null | undefined;
  timeZone?: string;
}): boolean {
  const backup = time(s.lastBackupAt);
  if (backup === null) return true;
  const slot = lastScheduledAt(s.now, s.time, s.timeZone);
  return backup < slot.getTime() - 24 * 3_600_000;
}
