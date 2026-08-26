/**
 * Every SELECT of a Snowflake-typed column (see schema.ts) MUST go
 * through this helper instead of a plain `.select("col")`. Without it,
 * better-sqlite3 hands back a JS `number` for any INTEGER column,
 * silently rounding once the value exceeds 2^53 -- which real Discord
 * snowflakes routinely do. CAST(col AS TEXT) forces SQLite itself to do
 * the int64-to-string conversion (exact, in its own C code) before the
 * value ever crosses into JS, so the driver only ever sees a string.
 * CAST(NULL AS TEXT) is NULL, so this is safe on nullable columns too.
 */
import { sql, type RawBuilder } from "kysely";

export function snowflake(column: string): RawBuilder<string | null> {
  return sql`CAST(${sql.ref(column)} AS TEXT)`;
}
