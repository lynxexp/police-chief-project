/**
 * Materializes a custom_events row into its linked vault_notifications
 * row -- extracted from routes/customEvents.ts as its own module since
 * it's a meaningful, self-contained piece of logic on its own.
 *
 * When notificationsEnabled is false, the event is calendar-only: any
 * previously materialized notification is dropped and nothing new is
 * created. routes/calendar.ts computes such an event's occurrences
 * directly from its recurrence fields instead of from notification
 * history, since there's no notification trail for a silent event.
 */
import { eventsDb } from "../db/connections.js";
import { calculateNextOccurrence } from "./nextOccurrence.js";
import { encodeCustomTimesDescription } from "./description.js";
import { toUtcIsoString } from "./timezone.js";
import { deleteNotificationRow } from "./deleteNotification.js";
import { buildDescription, writeEmbedRow, type EmbedInput } from "./embed.js";

export const DEFAULT_CUSTOM_EVENT_MESSAGE = "%i **%n** starts in %t!";

const NOTIFICATION_TYPE_PRESETS: Record<number, number[]> = {
  1: [30, 10, 5, 0],
  2: [10, 5, 0],
  3: [5, 0],
  4: [5],
  5: [0],
};

/** Mirrors CustomEventSession.reminder_offsets(). */
export function reminderOffsetsFor(notificationType: number, customTimes: number[] | undefined): number[] {
  if (notificationType === 6 && customTimes && customTimes.length > 0) return customTimes;
  return NOTIFICATION_TYPE_PRESETS[notificationType] ?? [10, 5, 0];
}

/** Mirrors save_custom_event()'s repeat_minutes derivation exactly. */
export function repeatMinutesForRecurrence(recurrenceType: string, interval: number): number {
  if (recurrenceType === "daily") return Math.max(1, interval) * 1440;
  if (recurrenceType === "weekly") return Math.max(1, interval) * 7 * 1440;
  return -2;
}

export interface MaterializeParams {
  guildId: string;
  customEventId: number;
  name: string;
  firstOccurrenceIso: string;
  recurrenceType: string;
  recurrenceInterval: number;
  createdBy: string;
  /** Defaults to true (materialize normally) so existing call sites don't
   * need to change. Pass false for a calendar-only event. */
  notificationsEnabled?: boolean;
  channelId?: string;
  channelName?: string | null;
  mentionType?: string;
  notificationType?: number;
  customTimes?: number[];
  messageKind?: "plain" | "embed";
  message?: string;
  embed?: EmbedInput;
}

/** Drops whatever notification(s) were previously materialized for this
 * custom event, then (unless notifications are disabled) inserts a fresh
 * one -- mirrors save_custom_event()'s "simplest way to keep the reminder
 * in sync" delete-then-recreate. */
export async function materializeCustomEventNotification(params: MaterializeParams): Promise<void> {
  const old = await eventsDb
    .selectFrom("vault_notifications")
    .select(["id", "channel_name", "mention_type"])
    .where("custom_event_id", "=", params.customEventId)
    .execute();
  for (const row of old) {
    await deleteNotificationRow(row.id);
  }

  const notificationsEnabled = params.notificationsEnabled ?? true;

  // custom_events.reminder_offsets is a read-only display cache (list/
  // detail pages). This is the one place that knows the true resolved
  // value (or that there isn't one), so it's the one place responsible
  // for keeping the cache correct.
  if (!notificationsEnabled) {
    await eventsDb
      .updateTable("custom_events")
      .set({ reminder_offsets: "[]" })
      .where("id", "=", params.customEventId)
      .execute();
    return;
  }

  if (!params.channelId) {
    throw new Error(`materializeCustomEventNotification: channelId required when notifications are enabled (event ${params.customEventId})`);
  }
  const channelName = params.channelName !== undefined ? params.channelName : (old[0]?.channel_name ?? null);
  const mentionType = params.mentionType ?? old[0]?.mention_type;
  if (mentionType === undefined || mentionType === null) {
    throw new Error(`materializeCustomEventNotification: no mentionType available for event ${params.customEventId}`);
  }

  const firstOccurrence = new Date(params.firstOccurrenceIso);
  const nextOcc = calculateNextOccurrence(firstOccurrence, params.recurrenceType, params.recurrenceInterval, new Date());
  if (!nextOcc) {
    throw new Error(`calculateNextOccurrence returned null for recurrenceType "${params.recurrenceType}"`);
  }

  const notificationType = params.notificationType!;
  const messageKind = params.messageKind ?? "plain";
  const message = params.message?.trim() || DEFAULT_CUSTOM_EVENT_MESSAGE;
  const offsets = reminderOffsetsFor(notificationType, params.customTimes);
  const innerDescription = buildDescription(messageKind, message, params.embed);
  const description = encodeCustomTimesDescription(offsets, innerDescription);
  const repeatMinutes = repeatMinutesForRecurrence(params.recurrenceType, params.recurrenceInterval);

  await eventsDb
    .updateTable("custom_events")
    .set({ reminder_offsets: JSON.stringify([...offsets].sort((a, b) => b - a)) })
    .where("id", "=", params.customEventId)
    .execute();

  const result = await eventsDb
    .insertInto("vault_notifications")
    .values({
      guild_id: params.guildId,
      channel_id: params.channelId,
      channel_name: channelName,
      // Always UTC for custom events -- see save_custom_event()'s
      // hardcoded `timezone="UTC"`.
      hour: nextOcc.getUTCHours(),
      minute: nextOcc.getUTCMinutes(),
      timezone: "UTC",
      description,
      notification_type: 6,
      mention_type: mentionType,
      repeat_enabled: 1,
      repeat_minutes: repeatMinutes,
      created_by: params.createdBy,
      next_notification: toUtcIsoString(nextOcc),
      event_type: params.name,
      custom_event_id: params.customEventId,
    })
    .executeTakeFirst();

  if (messageKind === "embed" && params.embed) {
    await writeEmbedRow(Number(result.insertId), params.embed);
  }
}
