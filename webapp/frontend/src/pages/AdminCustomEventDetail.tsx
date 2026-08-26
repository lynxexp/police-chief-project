import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAllianceGuild,
  getAllianceChannels,
  getCustomEvent,
  updateCustomEvent,
  deleteCustomEvent,
} from "../api/client";
import CustomEventForm, {
  draftFromCustomEvent,
  draftToInput,
  isDraftValid,
} from "../components/CustomEventForm";
import { formatUtcAndLocal } from "../utils/time";
import { Badge, Card, ErrorState, LoadingState, buttonDanger, buttonPrimary, buttonSecondary } from "../components/ui";

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
    <Layout
      title="Custom event"
      backTo={{ to: `/admin/alliances/${allianceId}/custom-events`, label: "Custom events" }}
    >
      {eventQuery.isLoading && <LoadingState />}
      {eventQuery.error && <ErrorState message="Couldn't load this custom event." />}

      {e && (
        <div className="space-y-4">
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
                if (
                  confirm(
                    "Delete this custom event? Its linked notification will also be deleted. This cannot be undone.",
                  )
                )
                  deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className={buttonDanger}
            >
              Delete
            </button>
          </div>

          {editing && draft && (
            <Card className="border-indigo-900">
              <div className="mb-3 font-medium text-slate-200">Edit custom event</div>
              <CustomEventForm draft={draft} onChange={setDraft} channels={channelsQuery.data} />
              <button
                onClick={() => saveMutation.mutate()}
                disabled={!isDraftValid(draft) || saveMutation.isPending}
                className={`mt-3 ${buttonPrimary}`}
              >
                Save changes
              </button>
              {saveMutation.isError && (
                <p className="mt-2 text-sm text-red-400">{(saveMutation.error as Error).message}</p>
              )}
            </Card>
          )}

          <Card>
            <div className="mb-3 flex items-center gap-2 text-lg font-medium">
              <span>{e.iconUrl || "📅"}</span>
              <span>{e.name}</span>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">First occurrence</dt>
                <dd>{formatUtcAndLocal(e.firstOccurrence)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Repeats</dt>
                <dd>
                  {e.recurrenceType ?? "?"}, every {e.recurrenceInterval ?? 1}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Reminder offsets</dt>
                <dd>{e.reminderOffsets.join(", ") || "—"} min before</dd>
              </div>
              <div>
                <dt className="text-slate-500">Notifications</dt>
                <dd>
                  {e.notificationsEnabled ? (
                    <Badge variant="success">On</Badge>
                  ) : (
                    <Badge>Off — calendar-only</Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Channel</dt>
                <dd>
                  {e.channelId
                    ? `#${channelsQuery.data?.find((c) => c.id === e.channelId)?.name ?? e.channelId}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Created by</dt>
                <dd>{e.createdByName ?? e.createdBy}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Created at</dt>
                <dd>{e.createdAt ? new Date(e.createdAt).toLocaleString() : "—"}</dd>
              </div>
            </dl>
          </Card>

          <Card>
            <div className="mb-1 font-medium text-slate-200">Discord reminder</div>
            <p className="mb-3 text-xs text-slate-500">
              The actual message the bot posts to Discord for this event, based on the settings above.
            </p>
            {e.materializedNotification ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Status</dt>
                  <dd>
                    <Badge variant={e.materializedNotification.isEnabled ? "success" : "neutral"}>
                      {e.materializedNotification.isEnabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Next reminder</dt>
                  <dd>{formatUtcAndLocal(e.materializedNotification.nextNotification)}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Last sent</dt>
                  <dd>{formatUtcAndLocal(e.materializedNotification.lastNotification)}</dd>
                </div>
                {e.materializedNotification.autoDisabledAt && (
                  <div>
                    <dt className="text-amber-400">Automatically disabled</dt>
                    <dd className="text-amber-400">
                      {formatUtcAndLocal(e.materializedNotification.autoDisabledAt)}
                    </dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-sm text-slate-400">
                {e.notificationsEnabled
                  ? "No reminder is scheduled for this event yet."
                  : "Notifications are off for this event -- nothing gets posted to Discord."}
              </p>
            )}
          </Card>
        </div>
      )}
    </Layout>
  );
}
