import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAllianceGuild,
  getAllianceChannels,
  getScheduleBoards,
  getSchedulePreview,
  type ScheduleBucketKey,
} from "../api/client";

const BUCKET_LABELS: { key: ScheduleBucketKey; label: string; badge: string }[] = [
  { key: "imminent", label: "Imminent (< 1 hour)", badge: "bg-red-950 text-red-400" },
  { key: "soon", label: "Soon (1-6 hours)", badge: "bg-amber-950 text-amber-400" },
  { key: "upcoming", label: "Upcoming (6-24 hours)", badge: "bg-emerald-950 text-emerald-400" },
  { key: "thisWeek", label: "2-7 days", badge: "bg-slate-800 text-slate-300" },
  { key: "nextWeek", label: "1-2 weeks", badge: "bg-slate-800 text-slate-300" },
  { key: "later", label: "Future (14+ days)", badge: "bg-slate-800 text-slate-300" },
];

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "long",
    weekday: "long",
    timeZone: "UTC",
  });
}

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
    <Layout
      title="Schedule boards"
      backTo={{ to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications" }}
    >
      {guildQuery.data && !guildId && (
        <p className="text-slate-400">This alliance has no linked Discord server.</p>
      )}

      {guildId && (
        <div className="space-y-6">
          <div>
            <h2 className="mb-3 text-sm font-medium text-slate-300">Configured boards</h2>
            <p className="mb-3 text-xs text-slate-500">
              Read-only -- board creation, editing, and deletion stay in Discord (the "Schedule Boards"
              menu), since every change there requires posting or editing the pinned message directly.
            </p>
            {boardsQuery.isLoading && <p className="text-slate-400">Loading…</p>}
            {boardsQuery.error && <p className="text-red-400">Couldn't load schedule boards.</p>}
            {boardsQuery.data && boardsQuery.data.length === 0 && (
              <p className="text-slate-400">No schedule boards configured for this server.</p>
            )}
            {boardsQuery.data && boardsQuery.data.length > 0 && (
              <div className="space-y-2">
                {boardsQuery.data.map((b) => (
                  <div key={b.id} className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="font-medium">
                        {b.boardType === "server" ? "Server-wide" : "Channel"} board
                      </span>
                      <span className="text-slate-500">in #{b.channelId}</span>
                      {b.boardType === "channel" && b.targetChannelId && (
                        <span className="text-slate-500">tracking #{b.targetChannelId}</span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                      <span>Max {b.maxEvents} events</span>
                      <span>{b.timezoneDisplay}</span>
                      {b.showDisabled && <span>Shows disabled</span>}
                      {!b.showRepeatingEvents && <span>Repeats hidden</span>}
                      {!b.hideDailyReset && <span>Daily reset shown</span>}
                      {b.filterName && <span>Filter: {b.filterName}</span>}
                      {b.filterTimeRange && <span>Within {b.filterTimeRange}h</span>}
                      {b.lastUpdated && <span>Updated {new Date(b.lastUpdated).toLocaleString()}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-slate-800 pt-6">
            <h2 className="mb-3 text-sm font-medium text-slate-300">Live preview</h2>
            <p className="mb-3 text-xs text-slate-500">
              Runs the same imminent/soon/upcoming grouping a real board's embed would, live against
              current notifications -- pick filters to see what a board configured this way would show
              right now.
            </p>

            <div className="mb-4 grid max-w-2xl grid-cols-2 gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Scope</label>
                <select
                  value={boardType}
                  onChange={(e) => {
                    setBoardType(e.target.value as "server" | "channel");
                    setPage(0);
                  }}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
                >
                  <option value="server">Server-wide</option>
                  <option value="channel">One channel</option>
                </select>
              </div>
              {boardType === "channel" && (
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Channel</label>
                  <select
                    value={targetChannelId}
                    onChange={(e) => {
                      setTargetChannelId(e.target.value);
                      setPage(0);
                    }}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
                  >
                    <option value="">— select —</option>
                    {channelsQuery.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs text-slate-400">Max events</label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={maxEvents}
                  onChange={(e) => {
                    setMaxEvents(Number(e.target.value));
                    setPage(0);
                  }}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Timezone</label>
                <input
                  value={timezone}
                  onChange={(e) => {
                    setTimezone(e.target.value);
                    setPage(0);
                  }}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Filter name (comma-separated)</label>
                <input
                  value={filterName}
                  onChange={(e) => {
                    setFilterName(e.target.value);
                    setPage(0);
                  }}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Within next N hours</label>
                <input
                  type="number"
                  min={1}
                  value={filterTimeRangeHours}
                  onChange={(e) => {
                    setFilterTimeRangeHours(e.target.value);
                    setPage(0);
                  }}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={showDisabled}
                  onChange={(e) => {
                    setShowDisabled(e.target.checked);
                    setPage(0);
                  }}
                  className="rounded border-slate-700 bg-slate-950"
                />
                Show disabled
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={showRepeatingEvents}
                  onChange={(e) => {
                    setShowRepeatingEvents(e.target.checked);
                    setPage(0);
                  }}
                  className="rounded border-slate-700 bg-slate-950"
                />
                Expand repeats
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={hideDailyReset}
                  onChange={(e) => {
                    setHideDailyReset(e.target.checked);
                    setPage(0);
                  }}
                  className="rounded border-slate-700 bg-slate-950"
                />
                Hide "Daily Reset"
              </label>
            </div>

            {previewQuery.isLoading && <p className="text-slate-400">Loading preview…</p>}
            {previewQuery.error && <p className="text-red-400">Couldn't load preview.</p>}
            {previewQuery.data && previewQuery.data.isEmpty && (
              <p className="text-slate-400">No upcoming events match these filters.</p>
            )}

            {previewQuery.data && !previewQuery.data.isEmpty && (
              <div className="max-w-2xl space-y-4">
                <div
                  className="rounded-lg border-l-4 bg-slate-900 p-4"
                  style={{ borderColor: `#${previewQuery.data.color.toString(16).padStart(6, "0")}` }}
                >
                  <p className="mb-3 text-xs text-slate-500">
                    Showing all upcoming events in {previewQuery.data.timezoneDisplay}.
                  </p>
                  {BUCKET_LABELS.map(({ key, label, badge }) => {
                    const days = previewQuery.data!.sections[key];
                    if (days.length === 0) return null;
                    return (
                      <div key={key} className="mb-4">
                        <span className={`mb-2 inline-block rounded px-2 py-0.5 text-xs font-medium ${badge}`}>
                          {label}
                        </span>
                        {days.map((day) => (
                          <div key={day.date} className="mt-2">
                            <div className="text-xs font-medium text-slate-400">{formatDate(day.date)}</div>
                            <ul className="mt-1 space-y-1 pl-3 text-sm">
                              {day.events.map((ev, i) => (
                                <li key={i} className="text-slate-300">
                                  <span className="font-medium">{ev.timeLabel}</span> - {ev.icon} {ev.name}
                                  {ev.channelId && <span className="text-slate-500"> #{ev.channelId}</span>}
                                  {!ev.isEnabled && <span className="ml-1 text-amber-400">[DISABLED]</span>}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  <p className="text-xs text-slate-500">
                    Last updated: {new Date(previewQuery.data.lastUpdated).toLocaleString()}
                  </p>
                </div>

                <div className="flex items-center gap-3 text-xs">
                  <button
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0}
                    className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-40"
                  >
                    Newer
                  </button>
                  <span className="text-slate-500">
                    Page {previewQuery.data.page + 1} of {previewQuery.data.totalPages} ({previewQuery.data.totalEvents} events)
                  </span>
                  <button
                    onClick={() => setPage(page + 1)}
                    disabled={previewQuery.data.page >= previewQuery.data.totalPages - 1}
                    className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-40"
                  >
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
