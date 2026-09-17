/**
 * Apply every pending migration in `./migrations`, in order, non-interactively.
 *
 * `drizzle-kit push` diffs live schema against the code and can prompt for a
 * rename-or-drop decision, which hangs in CI (no TTY). This runs the
 * already-generated, already-reviewed SQL files instead: nothing to decide,
 * nothing to prompt for. This is what CI and a real deployment run; `push` is
 * for interactive local development only.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set; nothing to migrate against.");
    process.exit(1);
  }

  const client = postgres(url, {
    max: 1,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
  const db = drizzle(client);

  console.log("[migrate] applying pending migrations from ./migrations ...");
  await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
  console.log("[migrate] done.");

  await client.end({ timeout: 5 });
}

main().catch((error: unknown) => {
  console.error("[migrate] failed:", error);
  process.exit(1);
});
