import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getAllianceGuild, getAllianceChannels, getCustomEvent, updateCustomEvent, deleteCustomEvent } from "../api/client";
import CustomEventForm, { draftFromCustomEvent, draftToInput, isDraftValid } from "../components/CustomEventForm";
import { formatUtcAndLocal } from "../utils/time";
import { Badge, Card, ErrorState, LoadingState, buttonDanger, buttonPrimary, buttonSecondary } from "../components/ui";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">{label}</dt>
      <dd className="mt-0.5 text-ink-secondary">{children}</dd>
    </div>
  );
}

export default function AdminCustomEventDetail() {
  const { allianceId: allianceIdParam, id: idParam } = useParams<{ allianceId: string; id: string }>();
  const allianceId = Number(allianceIdParam);
  const id = Number(idParam);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof draftFromCustomEvent> | null>(null);

  const guildQuery = useQuery({
    queryKey: ["admin-alliance-guild", allianceId],
    queryFn: () => getAllianceGuild(allianceId),
  });
  const guildId = guildQuery.data?.guildId ?? null;

  const channelsQuery = useQuery({
    queryKey: ["admin-alliance-channels", allianceId],
    queryFn: () => getAllianceChannels(allianceId),
  });

  const eventQuery = useQuery({
    queryKey: ["admin-guild-custom-event", guildId, id],
    queryFn: () => getCustomEvent(guildId!, id),
    enabled: !!guildId,
  });
  const e = eventQuery.data;

  useEffect(() => {
    if (e && !editing) setDraft(draftFromCustomEvent(e));
  }, [e, editing]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-guild-custom-event", guildId, id] });

  const saveMutation = useMutation({
    mutationFn: () => {
      const channelName = channelsQuery.data?.find((c) => c.id === draft!.channelId)?.name ?? null;
      return updateCustomEvent(guildId!, id, draftToInput(draft!, channelName));
    },
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteCustomEvent(guildId!, id),
    onSuccess: () => navigate(`/admin/alliances/${allianceId}/custom-events`),
  });

  return (
    <Layout title="Custom event" backTo={{ to: `/admin/alliances/${allianceId}/custom-events`, label: "Custom events" }}>
      {eventQuery.isLoading && <LoadingState />}
      {eventQuery.error && <ErrorState message="Couldn't load this custom event." onRetry={eventQuery.refetch} />}

      {e && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setDraft(draftFromCustomEvent(e));
                setEditing((v) => !v);
              }}
              className={buttonSecondary}
            >
              {editing ? "Cancel edit" : "Edit"}
            </button>
            <button
              onClick={() => {
                if (confirm("Delete this custom event? Its linked notification will also be deleted. This cannot be undone.")) deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className={buttonDanger}
            >
              Delete
            </button>
          </div>

          {editing && draft && (
            <Card className="border-gold-border">
              <p className="mb-3 font-display text-[15px] font-semibold tracking-heading text-ink uppercase">Edit custom event</p>
              <CustomEventForm draft={draft} onChange={setDraft} channels={channelsQuery.data} />
              <div className="mt-4">
                <button onClick={() => saveMutation.mutate()} disabled={!isDraftValid(draft) || saveMutation.isPending} className={buttonPrimary}>
                  Save changes
                </button>
                {saveMutation.isError && <p className="mt-2 text-sm text-down-ink">{(saveMutation.error as Error).message}</p>}
              </div>
            </Card>
          )}

          <div className="overflow-hidden rounded-card border border-gold-border">
            <div className="flex items-center gap-2 bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-4 py-2 font-sans text-sm font-semibold text-on-gold">
              <span aria-hidden="true">{e.iconUrl || "📅"}</span>
              <span>{e.name}</span>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 bg-surface-panel p-4 text-sm sm:grid-cols-2">
              <Fact label="First occurrence">{formatUtcAndLocal(e.firstOccurrence)}</Fact>
              <Fact label="Repeats">
                {e.recurrenceType ?? "?"}, every {e.recurrenceInterval ?? 1}
              </Fact>
              <Fact label="Reminder offsets">{e.reminderOffsets.join(", ") || "—"} min before</Fact>
              <Fact label="Notifications">
                {e.notificationsEnabled ? <Badge variant="success">On</Badge> : <Badge>Off — calendar-only</Badge>}
              </Fact>
              <Fact label="Channel">{e.channelId ? `#${channelsQuery.data?.find((c) => c.id === e.channelId)?.name ?? e.channelId}` : "—"}</Fact>
              <Fact label="Created by">{e.createdByName ?? e.createdBy}</Fact>
              <Fact label="Created at">{e.createdAt ? new Date(e.createdAt).toLocaleString() : "—"}</Fact>
            </dl>
          </div>

          <Card>
            <p className="mb-1 font-display text-[15px] font-semibold tracking-heading text-ink uppercase">Discord reminder</p>
            <p className="mb-3 text-xs text-ink-faint">The actual message the bot posts to Discord for this event, based on the settings above.</p>
            {e.materializedNotification ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <Fact label="Status">
                  <Badge variant={e.materializedNotification.isEnabled ? "success" : "neutral"}>
                    {e.materializedNotification.isEnabled ? "Enabled" : "Disabled"}
                  </Badge>
                </Fact>
                <Fact label="Next reminder">{formatUtcAndLocal(e.materializedNotification.nextNotification)}</Fact>
                <Fact label="Last sent">{formatUtcAndLocal(e.materializedNotification.lastNotification)}</Fact>
                {e.materializedNotification.autoDisabledAt && (
                  <div>
                    <dt className="font-mono text-[10px] tracking-eyebrow text-gold-ink uppercase">Automatically disabled</dt>
                    <dd className="mt-0.5 text-gold-ink">{formatUtcAndLocal(e.materializedNotification.autoDisabledAt)}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-sm text-ink-muted">
                {e.notificationsEnabled ? "No reminder is scheduled for this event yet." : "Notifications are off for this event -- nothing gets posted to Discord."}
              </p>
            )}
          </Card>
        </div>
      )}
    </Layout>
  );
}
