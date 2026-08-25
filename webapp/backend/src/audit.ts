/**
 * Activity log for this app's own mutating routes -- separate from the
 * bot's permission_audit_log (see db/schema.ts's AppAuditLogTable doc
 * comment). Never throws: a logging failure must not fail the mutation
 * it's describing, same rationale as auth/permissions.ts's logChange().
 */
import { webappDb } from "./db/connections.js";
import { snowflake } from "./db/snowflake.js";

export interface LogAppActionParams {
  actorId: string;
  guildId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  detail?: string | null;
}

export async function logAppAction(params: LogAppActionParams): Promise<void> {
  try {
    await webappDb
      .insertInto("app_audit_log")
      .values({
        actor_id: params.actorId,
        guild_id: params.guildId ?? null,
        action: params.action,
        resource_type: params.resourceType,
        resource_id: params.resourceId ?? null,
        detail: params.detail ?? null,
        created_at: new Date().toISOString(),
      })
      .execute();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to write app audit log:", err);
  }
}

export interface AppAuditLogRow {
  actorId: string;
  guildId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: string | null;
  createdAt: string;
}

export interface AppAuditLogPage {
  rows: AppAuditLogRow[];
  total: number;
}

export async function getAppAuditLogPage(offset = 0, limit = 10): Promise<AppAuditLogPage> {
  const totalRow = await webappDb
    .selectFrom("app_audit_log")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();

  const rows = await webappDb
    .selectFrom("app_audit_log")
    .select([
      snowflake("actor_id").as("actor_id"),
      snowflake("guild_id").as("guild_id"),
      "action", "resource_type", "resource_id", "detail", "created_at",
    ])
    .orderBy("id", "desc")
    .offset(offset)
    .limit(limit)
    .execute();

  return {
    total: Number(totalRow.count),
    rows: rows.map((r) => ({
      actorId: r.actor_id!, // NOT NULL column; CAST(x AS TEXT) is only nullable in the type
      guildId: r.guild_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  };
}
