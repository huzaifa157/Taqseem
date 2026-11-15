import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Not env("DATABASE_URL"): that throws when the variable is missing, and `prisma generate`
    // (postinstall) needs no database, so an install without it (a Vercel build where the variable
    // is not set for that environment, CI) failed. Commands that use the database still need it.
    url: process.env.DATABASE_URL ?? "",
  },
});
