import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getAllianceGuild, getCustomEvents, getCustomEventSuggestions } from "../api/client";
import { formatUtcAndLocal } from "../utils/time";
import { EmptyState, ErrorState, LoadingRows, Shield, buttonPrimary } from "../components/ui";

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
          <Link to={`/admin/alliances/${allianceId}/custom-events/new`} className={buttonPrimary}>
            + New custom event
          </Link>
        )
      }
    >
      {guildQuery.isLoading && <LoadingRows rows={3} />}
      {guildQuery.data && !guildId && <p className="text-sm text-ink-muted">This alliance has no linked Discord server.</p>}

      {suggestionsQuery.data && suggestionsQuery.data.missing.length > 0 && (
        <div className="flex flex-col gap-2">
          {suggestionsQuery.data.missing.map((eventType) => (
            <div
              key={eventType}
              className="flex items-center gap-3.5 rounded-card border border-gold-border p-4"
              style={{ background: "linear-gradient(135deg, #2A2214, var(--surface-panel))" }}
            >
              <Shield size={40} tone="gold">
                !
              </Shield>
              <p className="flex-1 text-sm text-ink-secondary">
                <span className="font-semibold text-ink">{eventType}</span> has attendance data recorded, but no
                reminder is set up for it.
              </p>
              <Link
                to={`/admin/alliances/${allianceId}/custom-events/new?prefillName=${encodeURIComponent(eventType)}`}
                className="shrink-0 font-sans text-sm font-medium text-gold-ink hover:text-text"
              >
                Create reminder →
              </Link>
            </div>
          ))}
        </div>
      )}

      {eventsQuery.isLoading && <LoadingRows rows={4} />}
      {eventsQuery.error && <ErrorState message="Couldn't load custom events." onRetry={eventsQuery.refetch} />}
      {eventsQuery.data && eventsQuery.data.length === 0 && <EmptyState>No custom events configured for this server.</EmptyState>}

      {eventsQuery.data && eventsQuery.data.length > 0 && (
        <div className="flex flex-col gap-2">
          {eventsQuery.data.map((e) => (
            <Link key={e.id} to={`/admin/alliances/${allianceId}/custom-events/${e.id}`} className="block rounded-card border border-line bg-surface-panel p-4 hover:border-line-strong">
              <div className="flex items-center gap-2 font-sans text-sm font-semibold text-ink">
                <span aria-hidden="true">{e.iconUrl || "📅"}</span>
                <span>{e.name}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-faint">
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
