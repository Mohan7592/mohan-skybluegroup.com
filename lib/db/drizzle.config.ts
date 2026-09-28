import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  // Versioned SQL migrations. Schema changes are made by editing src/schema and
  // running `pnpm --filter @workspace/db run generate`; never by `push` on a
  // shared/production database. See lib/db/MIGRATIONS.md.
  out: "./migrations", // relative to lib/db (drizzle-kit mis-handles absolute out paths)
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
