import { describe, expect, it } from "vitest";

import { newerThanTools } from "./engine";

describe("cloud database version against the backup tools", () => {
  it("refuses a cloud PostgreSQL newer than pg_dump (a restore from it would fail)", () => {
    // Neon's default: PostgreSQL 18; the installer's tools: 17.
    expect(newerThanTools(180007, 17)).toMatch(/PostgreSQL 18, newer than .*PostgreSQL 17/);
    expect(newerThanTools(170005, 17)).toBeNull();
    expect(newerThanTools(170005, 18)).toBeNull(); // newer tools read older servers
    expect(newerThanTools(180007, null)).toBeNull(); // tools unknown (development): not checked
  });
});
