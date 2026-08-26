import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getAllianceGuild, getCustomEvents, getCustomEventSuggestions } from "../api/client";
import { formatUtcAndLocal } from "../utils/time";
import { EmptyState, ErrorState, LoadingState } from "../components/ui";

export default function AdminCustomEvents() {
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);

  const guildQuery = useQuery({
    queryKey: ["admin-alliance-guild", allianceId],
    queryFn: () => getAllianceGuild(allianceId),
  });
  const guildId = guildQuery.data?.guildId ?? null;

  const eventsQuery = useQuery({
    queryKey: ["admin-guild-custom-events", guildId],
    queryFn: () => getCustomEvents(guildId!),
    enabled: !!guildId,
  });

  const suggestionsQuery = useQuery({
    queryKey: ["admin-custom-event-suggestions", allianceId],
    queryFn: () => getCustomEventSuggestions(allianceId),
    enabled: !!guildId,
  });

  return (
    <Layout
      title="Custom events"
      backTo={{ to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications" }}
      actions={
        guildId && (
          <Link
            to={`/admin/alliances/${allianceId}/custom-events/new`}
            className="inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            + New custom event
          </Link>
        )
      }
    >
      {guildQuery.isLoading && <LoadingState />}
      {guildQuery.data && !guildId && (
        <p className="text-slate-400">This alliance has no linked Discord server.</p>
      )}

      {suggestionsQuery.data && suggestionsQuery.data.missing.length > 0 && (
        <div className="mb-4 space-y-2">
          {suggestionsQuery.data.missing.map((eventType) => (
            <div
              key={eventType}
              className="flex items-center justify-between rounded-lg border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-sm"
            >
              <span className="text-amber-200">
                {eventType} has attendance data recorded, but no reminder is set up for it.
              </span>
              <Link
                to={`/admin/alliances/${allianceId}/custom-events/new?prefillName=${encodeURIComponent(eventType)}`}
                className="shrink-0 rounded-md border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-900/40"
              >
                Create reminder →
              </Link>
            </div>
          ))}
        </div>
      )}

      {eventsQuery.isLoading && <LoadingState label="Loading events…" />}
      {eventsQuery.error && <ErrorState message="Couldn't load custom events." />}
      {eventsQuery.data && eventsQuery.data.length === 0 && (
        <EmptyState icon="🗓️">No custom events configured for this server.</EmptyState>
      )}

      {eventsQuery.data && eventsQuery.data.length > 0 && (
        <div className="space-y-2">
          {eventsQuery.data.map((e) => (
            <Link
              key={e.id}
              to={`/admin/alliances/${allianceId}/custom-events/${e.id}`}
              className="block rounded-lg border border-slate-800 bg-slate-900 p-4 hover:border-slate-700"
            >
              <div className="flex items-center gap-2 font-medium">
                <span>{e.iconUrl || "📅"}</span>
                <span>{e.name}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span>
                  {e.recurrenceType ?? "?"}, every {e.recurrenceInterval ?? 1}
                </span>
                {e.nextOccurrence && <span>Next: {formatUtcAndLocal(e.nextOccurrence)}</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </Layout>
  );
}
