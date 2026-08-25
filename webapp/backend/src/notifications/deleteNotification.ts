/**
 * Shared delete-with-cleanup for a single vault_notifications row. Used
 * by both the standalone DELETE endpoint (routes/notifications.ts) and
 * custom_events materialization's delete-then-recreate cycle
 * (routes/customEvents.ts, mirroring save_custom_event()'s "drop any
 * previously materialized reminder row(s), then recreate" approach).
 *
 * The bot's own delete_notification() only deletes the parent row --
 * SQLite's ON DELETE CASCADE on these FKs is inert (the bot never runs
 * PRAGMA foreign_keys = ON), so the real bot actually leaves
 * notification_history/vault_notification_embeds/notification_days
 * orphaned. Cleaning them up here doesn't change any user-visible
 * scheduling behavior, so there's no reason to also port that as a bug.
 */
import { eventsDb } from "../db/connections.js";

export async function deleteNotificationRow(id: number): Promise<void> {
  await eventsDb.transaction().execute(async (trx) => {
    await trx.deleteFrom("notification_history").where("notification_id", "=", id).execute();
    await trx.deleteFrom("vault_notification_embeds").where("notification_id", "=", id).execute();
    await trx.deleteFrom("notification_days").where("notification_id", "=", id).execute();
    await trx.deleteFrom("vault_notifications").where("id", "=", id).execute();
  });
}
