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
      {eventQuery.isLoading && <p className="text-slate-400">Loading…</p>}
      {eventQuery.error && <p className="text-red-400">Couldn't load this custom event.</p>}

      {e && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setDraft(draftFromCustomEvent(e));
                setEditing((v) => !v);
              }}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
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
              className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50"
            >
              Delete
            </button>
          </div>

          {editing && draft && (
            <div className="rounded-lg border border-indigo-900 bg-slate-900 p-4">
              <div className="mb-3 font-medium text-slate-200">Edit custom event</div>
              <CustomEventForm draft={draft} onChange={setDraft} channels={channelsQuery.data} />
              <button
                onClick={() => saveMutation.mutate()}
                disabled={!isDraftValid(draft) || saveMutation.isPending}
                className="mt-3 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Save changes
              </button>
              {saveMutation.isError && (
                <p className="mt-2 text-sm text-red-400">{(saveMutation.error as Error).message}</p>
              )}
            </div>
          )}

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="mb-3 flex items-center gap-2 text-lg font-medium">
              <span>{e.iconUrl || "📅"}</span>
              <span>{e.name}</span>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">First occurrence (UTC)</dt>
                <dd>{e.firstOccurrence ? new Date(e.firstOccurrence).toLocaleString() : "—"}</dd>
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
                <dt className="text-slate-500">Channel</dt>
                <dd>{e.channelId}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Created by</dt>
                <dd>{e.createdBy}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Created at</dt>
                <dd>{e.createdAt ? new Date(e.createdAt).toLocaleString() : "—"}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="mb-3 font-medium text-slate-200">Materialized reminder</div>
            {e.materializedNotification ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Status</dt>
                  <dd>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        e.materializedNotification.isEnabled
                          ? "bg-emerald-950 text-emerald-400"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {e.materializedNotification.isEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Next fire</dt>
                  <dd>
                    {e.materializedNotification.nextNotification
                      ? new Date(e.materializedNotification.nextNotification).toLocaleString()
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Last fired</dt>
                  <dd>
                    {e.materializedNotification.lastNotification
                      ? new Date(e.materializedNotification.lastNotification).toLocaleString()
                      : "—"}
                  </dd>
                </div>
                {e.materializedNotification.autoDisabledAt && (
                  <div>
                    <dt className="text-amber-400">Auto-disabled</dt>
                    <dd className="text-amber-400">
                      {new Date(e.materializedNotification.autoDisabledAt).toLocaleString()}
                    </dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-sm text-slate-400">No reminder is currently materialized for this event.</p>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
