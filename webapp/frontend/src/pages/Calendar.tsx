import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { CalendarPlus } from "lucide-react";
import Layout from "../components/Layout";
import {
  getAllianceCalendar,
  getCalendarFeedToken,
  getCalendarFeedUrl,
  getCalendarFeedWebcalUrl,
  regenerateCalendarFeedToken,
  type AuthContext,
  type CalendarEvent,
} from "../api/client";
import { Badge, buttonPrimary, buttonSecondary, Card, ErrorState } from "../components/ui";

const WEEKDAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toLocalDateKey(date: Date): string {
  // Local getters (not UTC) -- each viewer sees events grouped onto the
  // calendar day that matches THEIR wall clock, not a server-chosen
  // timezone. The backend returns raw UTC instants for exactly this.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Full 6-row grid (42 days) starting on the Sunday on/before the 1st of
 * the month -- simplest way to always show a consistent grid shape. */
function buildMonthGrid(monthStart: Date): Date[] {
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

export default function CalendarPage() {
  const ctx = useOutletContext<AuthContext>();
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);
  const queryClient = useQueryClient();

  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const feedUrlInputRef = useRef<HTMLInputElement>(null);

  const feedTokenQuery = useQuery({
    queryKey: ["calendar-feed-token"],
    queryFn: getCalendarFeedToken,
    enabled: showSubscribe,
    staleTime: Infinity,
  });

  const regenerateTokenMutation = useMutation({
    mutationFn: regenerateCalendarFeedToken,
    onSuccess: (token) => {
      queryClient.setQueryData(["calendar-feed-token"], token);
      setCopiedUrl(null);
    },
  });

  const feedUrl = feedTokenQuery.data ? getCalendarFeedUrl(allianceId, feedTokenQuery.data) : null;
  const webcalUrl = feedTokenQuery.data ? getCalendarFeedWebcalUrl(allianceId, feedTokenQuery.data) : null;

  function copyFeedUrl() {
    if (!feedUrl) return;
    // Clipboard access can be denied (browser setting, permissions
    // policy, non-HTTPS context) -- fall back to selecting the text
    // field so the link is still one action away from a manual copy.
    navigator.clipboard.writeText(feedUrl).then(
      () => setCopiedUrl(feedUrl),
      () => feedUrlInputRef.current?.select(),
    );
  }

  const grid = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);
  const rangeStart = toLocalDateKey(grid[0]!);
  const rangeEnd = toLocalDateKey(grid[grid.length - 1]!);

  const calendarQuery = useQuery({
    queryKey: ["alliance-calendar", allianceId, rangeStart, rangeEnd],
    queryFn: () => getAllianceCalendar(allianceId, rangeStart, rangeEnd),
  });

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of calendarQuery.data?.events ?? []) {
      const key = toLocalDateKey(new Date(event.time));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(event);
    }
    for (const list of map.values()) list.sort((a, b) => a.time.localeCompare(b.time));
    return map;
  }, [calendarQuery.data]);

  const todayKey = toLocalDateKey(new Date());
  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const selectedEvents = selectedDateKey ? (eventsByDate.get(selectedDateKey) ?? []) : [];

  const subscribeCard = (
    <Card>
      <p className="mb-1 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Subscribe</p>
      <p className="mb-4 text-xs text-ink-muted">
        Sync upcoming events to your phone or computer's own calendar app, with its normal reminders. The link
        below is personal to you.
      </p>

      {!showSubscribe && (
        <button onClick={() => setShowSubscribe(true)} className={`${buttonPrimary} w-full`}>
          <CalendarPlus size={16} strokeWidth={1.75} className="mr-1.5" aria-hidden="true" />
          One-click subscribe (webcal)
        </button>
      )}

      {showSubscribe && (
        <div className="flex flex-col gap-3">
          {feedTokenQuery.isLoading && <p className="text-sm text-ink-muted">Loading your subscribe link…</p>}
          {feedTokenQuery.error && <ErrorState message="Couldn't load your subscribe link." onRetry={feedTokenQuery.refetch} />}

          {feedUrl && webcalUrl && (
            <>
              <a href={webcalUrl} className={`${buttonPrimary} text-center`}>
                Add to Apple Calendar / Outlook
              </a>
              <button onClick={copyFeedUrl} className={buttonSecondary}>
                {copiedUrl === feedUrl ? "Copied!" : "Copy link for Google Calendar"}
              </button>
              <input
                ref={feedUrlInputRef}
                readOnly
                value={feedUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full truncate rounded-control border border-line bg-surface-sunken px-3 py-1.5 font-mono text-xs text-ink-muted"
              />
              <p className="text-xs text-down-ink">
                This link is personal to you — don't share it.{" "}
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        "Generate a new link? Your current link will stop working on any device it's already added to.",
                      )
                    ) {
                      regenerateTokenMutation.mutate();
                    }
                  }}
                  disabled={regenerateTokenMutation.isPending}
                  className="font-medium text-ink-secondary underline hover:text-ink"
                >
                  {regenerateTokenMutation.isPending ? "Generating…" : "Generate new link"}
                </button>
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );

  const dayPanel = selectedDateKey && (
    <Card>
      <p className="mb-3 font-mono text-sm font-bold text-gold-ink uppercase">
        {new Date(`${selectedDateKey}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
      </p>
      {selectedEvents.length === 0 ? (
        <p className="text-sm text-ink-muted">No events this day.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {selectedEvents.map((e) => (
            <li key={e.id} className="flex items-start gap-2.5 text-sm">
              <span
                className="mt-1 h-1 w-1 shrink-0 rounded-full"
                style={{ background: e.isPast ? "var(--text-faint)" : "var(--info-ink)" }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className={e.isPast ? "text-ink-faint" : "text-ink"}>
                  {e.icon} {e.name}
                </p>
                <p className="font-mono text-xs text-ink-muted">
                  {new Date(e.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
              {e.isPast && <Badge>Past</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <Layout
      title="Event calendar"
      backTo={{ to: `/alliance/${allianceId}`, label: "Alliance overview" }}
      actions={
        ctx.tier !== "none" && (
          <Link to={`/admin/alliances/${allianceId}/custom-events/new`} className={buttonPrimary}>
            + New event
          </Link>
        )
      }
    >
      {calendarQuery.data && !calendarQuery.data.guildId && (
        <p className="text-sm text-ink-muted">This alliance has no linked Discord server.</p>
      )}
      {ctx.tier !== "none" && (
        <p className="text-xs text-ink-faint">
          Events on this calendar come from Custom Events and Notifications, configured here.
        </p>
      )}
      {calendarQuery.error && <ErrorState message="Couldn't load the calendar." onRetry={calendarQuery.refetch} />}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <button onClick={() => { setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1)); setSelectedDateKey(null); }} className={buttonSecondary}>
              ← Prev
            </button>
            <span className="min-w-[9rem] text-center font-display text-sm font-semibold tracking-heading text-ink uppercase">{monthLabel}</span>
            <button onClick={() => { setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1)); setSelectedDateKey(null); }} className={buttonSecondary}>
              Next →
            </button>
            <button onClick={() => { setViewMonth(startOfMonth(new Date())); setSelectedDateKey(null); }} className={buttonSecondary}>
              Today
            </button>
            {calendarQuery.isFetching && <span className="font-mono text-[11px] text-ink-faint">loading…</span>}
          </div>

          {/* Desktop month grid */}
          <div className="hidden gap-[1px] overflow-hidden rounded-card border border-line bg-line-hairline sm:grid sm:grid-cols-7">
            {WEEKDAY_HEADERS.map((d) => (
              <div key={d} className="bg-surface-header px-2 py-1.5 text-center font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                {d}
              </div>
            ))}
            {grid.map((day) => {
              const key = toLocalDateKey(day);
              const inMonth = day.getMonth() === viewMonth.getMonth();
              const dayEvents = eventsByDate.get(key) ?? [];
              const isToday = key === todayKey;
              const isSelected = key === selectedDateKey;
              return (
                <button
                  key={key}
                  onClick={() => setSelectedDateKey(key === selectedDateKey ? null : key)}
                  className={`flex min-h-[92px] flex-col p-2 text-left ${
                    isToday ? "border border-gold-border bg-gold-tint" : inMonth ? "bg-surface-panel" : "bg-surface-header"
                  } ${isSelected ? "outline outline-2 outline-gold-ink" : ""}`}
                >
                  <span
                    className={`font-mono text-xs ${
                      isToday ? "font-bold text-gold-ink" : inMonth ? "text-ink-muted" : "text-ink-disabled"
                    }`}
                  >
                    {isToday ? `${day.getDate()} · TODAY` : day.getDate()}
                  </span>
                  <div className="mt-1 flex flex-1 flex-col gap-0.5 overflow-hidden">
                    {dayEvents.slice(0, 3).map((e) => (
                      <span
                        key={e.id}
                        className="truncate rounded-block px-1 py-0.5 text-[10px]"
                        style={{
                          background: isToday ? "linear-gradient(180deg, var(--gold-fill-from), var(--gold-fill-to))" : e.isPast ? "#1A2430" : "#1D2A38",
                          color: isToday ? "var(--on-gold)" : e.isPast ? "var(--text-muted)" : "var(--text-secondary)",
                          borderLeft: !isToday && !e.isPast ? "2px solid var(--info-ink)" : undefined,
                        }}
                      >
                        {e.icon} {e.name}
                      </span>
                    ))}
                    {dayEvents.length > 3 && <span className="text-[10px] text-ink-faint">+{dayEvents.length - 3} more</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Mobile: dot grid */}
          <div className="grid grid-cols-7 gap-1 sm:hidden">
            {WEEKDAY_HEADERS.map((d) => (
              <div key={d} className="text-center font-mono text-[10px] text-ink-faint uppercase">{d[0]}</div>
            ))}
            {grid.map((day) => {
              const key = toLocalDateKey(day);
              const inMonth = day.getMonth() === viewMonth.getMonth();
              const dayEvents = eventsByDate.get(key) ?? [];
              const isToday = key === todayKey;
              const isSelected = key === selectedDateKey;
              return (
                <button
                  key={key}
                  onClick={() => setSelectedDateKey(key === selectedDateKey ? null : key)}
                  className={`flex h-11 w-11 flex-col items-center justify-center rounded-control ${
                    isSelected ? "border border-gold-border bg-gold-tint" : ""
                  } ${!inMonth ? "opacity-40" : ""}`}
                >
                  <span className={`font-mono text-xs ${isToday ? "font-bold text-gold-ink" : "text-ink-secondary"}`}>{day.getDate()}</span>
                  {dayEvents.length > 0 && (
                    <span
                      className="mt-0.5 h-[5px] w-[5px] rounded-full"
                      style={{ background: isToday ? "var(--gold-ink)" : dayEvents.some((e) => !e.isPast) ? "var(--info-ink)" : "var(--border-strong)" }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-4 sm:hidden">{dayPanel}</div>
        </div>

        <div className="hidden flex-col gap-4 lg:flex">
          {dayPanel}
          {subscribeCard}
        </div>
        <div className="lg:hidden">{subscribeCard}</div>
      </div>
    </Layout>
  );
}
