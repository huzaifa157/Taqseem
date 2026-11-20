// Restores a new installation from its cloud backup (installer/setup/install.ps1, the wizard's
// "Restore my business from the cloud backup"). The same code as Settings → Cloud sync → Restore
// (src/server/sync/engine.ts restoreFromCloud): this computer's data is backed up to a file, the
// cloud copy is loaded, newer database updates are applied, and this installation takes over the
// daily backup into the same cloud database (an old computer that comes back is then refused).
//
//   node restore.mjs
//
// Everything comes from the environment, so the connection string never appears on a command line:
//   DATABASE_URL            this installation's database
//   TAQSEEM_CLOUD_URL       the cloud database's connection string
//   TAQSEEM_MIGRATIONS_DIR  the installed migrations
//   TAQSEEM_BACKUP_DIR      where the safety backup is written
//   PG_BIN                  pg_dump / pg_restore (the installer's pgsql\tools)
// Prints one line on success; on failure the reason, without the password, and exit code 1.

import { restoreFromCloud } from "../../src/server/sync/engine";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set.`);
    process.exit(2);
  }
  return value;
};

/** An error message with any connection-string password blanked out. */
const withoutPassword = (text: string) =>
  text.replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/gi, "$1*****@");

try {
  const result = await restoreFromCloud({
    localUrl: env("DATABASE_URL"),
    cloudUrl: env("TAQSEEM_CLOUD_URL"),
    migrationsDir: env("TAQSEEM_MIGRATIONS_DIR"),
    backupDir: env("TAQSEEM_BACKUP_DIR"),
    pgBin: process.env.PG_BIN,
  });
  console.log(
    `Restored from the cloud backup: ${result.customers} customers, ${result.orders} orders` +
      (result.updated ? `, ${result.updated} database updates applied` : "") +
      ".",
  );
} catch (error) {
  console.error(withoutPassword(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
