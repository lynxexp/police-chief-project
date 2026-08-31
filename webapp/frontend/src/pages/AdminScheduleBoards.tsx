import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getAllianceGuild, getAllianceChannels, getScheduleBoards, getSchedulePreview, type ScheduleBucketKey } from "../api/client";
import { Card, EmptyState, ErrorState, LoadingState, SectionHeading, Toggle, buttonSecondary } from "../components/ui";

const BUCKET_LABELS: { key: ScheduleBucketKey; label: string; badge: string }[] = [
  { key: "imminent", label: "Imminent (< 1 hour)", badge: "border border-down-border bg-down-tint text-down-ink" },
  { key: "soon", label: "Soon (1-6 hours)", badge: "border border-gold-border bg-gold-tint text-gold-ink" },
  { key: "upcoming", label: "Upcoming (6-24 hours)", badge: "border border-up-fill/40 bg-up-fill/10 text-up-ink" },
  { key: "thisWeek", label: "2-7 days", badge: "border border-line-strong bg-surface-sunken text-ink-muted" },
  { key: "nextWeek", label: "1-2 weeks", badge: "border border-line-strong bg-surface-sunken text-ink-muted" },
  { key: "later", label: "Future (14+ days)", badge: "border border-line-strong bg-surface-sunken text-ink-muted" },
];

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "2-digit", month: "long", weekday: "long", timeZone: "UTC" });
}

const fieldClass = "mt-1 w-full rounded-control border border-line bg-surface-sunken px-2 py-1.5 text-sm text-ink";

export default function AdminScheduleBoards() {
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);

  const guildQuery = useQuery({
    queryKey: ["admin-alliance-guild", allianceId],
    queryFn: () => getAllianceGuild(allianceId),
  });
  const guildId = guildQuery.data?.guildId ?? null;

  const channelsQuery = useQuery({
    queryKey: ["admin-alliance-channels", allianceId],
    queryFn: () => getAllianceChannels(allianceId),
  });

  const boardsQuery = useQuery({
    queryKey: ["admin-guild-schedule-boards", guildId],
    queryFn: () => getScheduleBoards(guildId!),
    enabled: !!guildId,
  });

  const [boardType, setBoardType] = useState<"server" | "channel">("server");
  const [targetChannelId, setTargetChannelId] = useState("");
  const [maxEvents, setMaxEvents] = useState(15);
  const [showDisabled, setShowDisabled] = useState(false);
  const [filterName, setFilterName] = useState("");
  const [filterTimeRangeHours, setFilterTimeRangeHours] = useState("");
  const [showRepeatingEvents, setShowRepeatingEvents] = useState(true);
  const [timezone, setTimezone] = useState("UTC");
  const [hideDailyReset, setHideDailyReset] = useState(true);
  const [page, setPage] = useState(0);

  const previewQuery = useQuery({
    queryKey: [
      "admin-guild-schedule-preview", guildId, boardType, targetChannelId, maxEvents,
      showDisabled, filterName, filterTimeRangeHours, showRepeatingEvents, timezone, hideDailyReset, page,
    ],
    queryFn: () =>
      getSchedulePreview(guildId!, {
        boardType,
        targetChannelId: boardType === "channel" ? targetChannelId : undefined,
        maxEvents,
        showDisabled,
        filterName: filterName.trim() || undefined,
        filterTimeRangeHours: filterTimeRangeHours ? Number(filterTimeRangeHours) : undefined,
        showRepeatingEvents,
        timezone,
        hideDailyReset,
        page,
      }),
    enabled: !!guildId && (boardType !== "channel" || !!targetChannelId),
  });

  return (
    <Layout title="Schedule boards" backTo={{ to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications" }}>
      {guildQuery.data && !guildId && <p className="text-sm text-ink-muted">This alliance has no linked Discord server.</p>}

      {guildId && (
        <div className="flex flex-col gap-6">
          <div>
            <SectionHeading>Configured boards</SectionHeading>
            <p className="mb-3 text-xs text-ink-faint">
              Read-only -- board creation, editing, and deletion stay in Discord (the "Schedule Boards" menu), since
              every change there requires posting or editing the pinned message directly.
            </p>
            {boardsQuery.isLoading && <LoadingState />}
            {boardsQuery.error && <ErrorState message="Couldn't load schedule boards." onRetry={boardsQuery.refetch} />}
            {boardsQuery.data && boardsQuery.data.length === 0 && <EmptyState>No schedule boards configured for this server.</EmptyState>}
            {boardsQuery.data && boardsQuery.data.length > 0 && (
              <div className="flex flex-col gap-2">
                {boardsQuery.data.map((b) => (
                  <Card key={b.id} className="p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="font-medium text-ink">{b.boardType === "server" ? "Server-wide" : "Channel"} board</span>
                      <span className="font-mono text-xs text-ink-muted">in #{b.channelId}</span>
                      {b.boardType === "channel" && b.targetChannelId && <span className="font-mono text-xs text-ink-muted">tracking #{b.targetChannelId}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-faint">
                      <span>Max {b.maxEvents} events</span>
                      <span>{b.timezoneDisplay}</span>
                      {b.showDisabled && <span>Shows disabled</span>}
                      {!b.showRepeatingEvents && <span>Repeats hidden</span>}
                      {!b.hideDailyReset && <span>Daily reset shown</span>}
                      {b.filterName && <span>Filter: {b.filterName}</span>}
                      {b.filterTimeRange && <span>Within {b.filterTimeRange}h</span>}
                      {b.lastUpdated && <span>Updated {new Date(b.lastUpdated).toLocaleString()}</span>}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-line-hairline pt-6">
            <SectionHeading>Live preview</SectionHeading>
            <p className="mb-3 text-xs text-ink-faint">
              Runs the same imminent/soon/upcoming grouping a real board's embed would, live against current
              notifications -- pick filters to see what a board configured this way would show right now.
            </p>

            <Card className="mb-4 grid max-w-2xl grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <label className="block">
                <span className="text-xs text-ink-muted">Scope</span>
                <select
                  value={boardType}
                  onChange={(e) => {
                    setBoardType(e.target.value as "server" | "channel");
                    setPage(0);
                  }}
                  className={fieldClass}
                >
                  <option value="server">Server-wide</option>
                  <option value="channel">One channel</option>
                </select>
              </label>
              {boardType === "channel" && (
                <label className="block">
                  <span className="text-xs text-ink-muted">Channel</span>
                  <select
                    value={targetChannelId}
                    onChange={(e) => {
                      setTargetChannelId(e.target.value);
                      setPage(0);
                    }}
                    className={fieldClass}
                  >
                    <option value="">Not set</option>
                    {channelsQuery.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block">
                <span className="text-xs text-ink-muted">Max events</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={maxEvents}
                  onChange={(e) => {
                    setMaxEvents(Number(e.target.value));
                    setPage(0);
                  }}
                  className={fieldClass}
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-muted">Timezone</span>
                <input
                  value={timezone}
                  onChange={(e) => {
                    setTimezone(e.target.value);
                    setPage(0);
                  }}
                  className={fieldClass}
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-muted">Filter name (comma-separated)</span>
                <input
                  value={filterName}
                  onChange={(e) => {
                    setFilterName(e.target.value);
                    setPage(0);
                  }}
                  className={fieldClass}
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-muted">Within next N hours</span>
                <input
                  type="number"
                  min={1}
                  value={filterTimeRangeHours}
                  onChange={(e) => {
                    setFilterTimeRangeHours(e.target.value);
                    setPage(0);
                  }}
                  className={fieldClass}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs text-ink-secondary">
                Show disabled
                <Toggle
                  checked={showDisabled}
                  onChange={(v) => {
                    setShowDisabled(v);
                    setPage(0);
                  }}
                  label="Show disabled"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs text-ink-secondary">
                Expand repeats
                <Toggle
                  checked={showRepeatingEvents}
                  onChange={(v) => {
                    setShowRepeatingEvents(v);
                    setPage(0);
                  }}
                  label="Expand repeats"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs text-ink-secondary">
                Hide "Daily Reset"
                <Toggle
                  checked={hideDailyReset}
                  onChange={(v) => {
                    setHideDailyReset(v);
                    setPage(0);
                  }}
                  label='Hide "Daily Reset"'
                />
              </label>
            </Card>

            {previewQuery.isLoading && <LoadingState label="Loading preview…" />}
            {previewQuery.error && <ErrorState message="Couldn't load preview." onRetry={previewQuery.refetch} />}
            {previewQuery.data && previewQuery.data.isEmpty && <p className="text-sm text-ink-muted">No upcoming events match these filters.</p>}

            {previewQuery.data && !previewQuery.data.isEmpty && (
              <div className="flex max-w-2xl flex-col gap-4">
                <div
                  className="rounded-card border-l-4 bg-surface-panel p-4"
                  style={{ borderLeftColor: `#${previewQuery.data.color.toString(16).padStart(6, "0")}` }}
                >
                  <p className="mb-3 font-mono text-xs text-ink-faint">Showing all upcoming events in {previewQuery.data.timezoneDisplay}.</p>
                  {BUCKET_LABELS.map(({ key, label, badge }) => {
                    const days = previewQuery.data!.sections[key];
                    if (days.length === 0) return null;
                    return (
                      <div key={key} className="mb-4">
                        <span className={`mb-2 inline-block rounded-pill px-2 py-0.5 font-mono text-[10px] font-bold tracking-pill uppercase ${badge}`}>{label}</span>
                        {days.map((day) => (
                          <div key={day.date} className="mt-2">
                            <p className="font-mono text-xs font-medium text-ink-muted">{formatDate(day.date)}</p>
                            <ul className="mt-1 flex flex-col gap-1 pl-3 text-sm">
                              {day.events.map((ev, i) => (
                                <li key={i} className="text-ink-secondary">
                                  <span className="font-mono font-medium text-ink">{ev.timeLabel}</span> - {ev.icon} {ev.name}
                                  {ev.channelId && <span className="font-mono text-ink-faint"> #{ev.channelId}</span>}
                                  {!ev.isEnabled && <span className="ml-1 text-gold-ink">[DISABLED]</span>}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  <p className="font-mono text-xs text-ink-faint">Last updated: {new Date(previewQuery.data.lastUpdated).toLocaleString()}</p>
                </div>

                <div className="flex items-center gap-3 text-xs">
                  <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className={`${buttonSecondary} px-2 py-1`}>
                    Newer
                  </button>
                  <span className="font-mono text-ink-faint">
                    Page {previewQuery.data.page + 1} of {previewQuery.data.totalPages} ({previewQuery.data.totalEvents} events)
                  </span>
                  <button onClick={() => setPage(page + 1)} disabled={previewQuery.data.page >= previewQuery.data.totalPages - 1} className={`${buttonSecondary} px-2 py-1`}>
                    Older
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
