import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getAllianceCalendar, type CalendarEvent } from "../api/client";

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
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);

  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);

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

  return (
    <Layout title="Event calendar" backTo={{ to: `/alliance/${allianceId}`, label: "Alliance overview" }}>
      {calendarQuery.data && !calendarQuery.data.guildId && (
        <p className="mb-4 text-slate-400">This alliance has no linked Discord server.</p>
      )}

      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => {
            setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
            setSelectedDateKey(null);
          }}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          ← Prev
        </button>
        <span className="min-w-[10rem] text-center text-sm font-medium">{monthLabel}</span>
        <button
          onClick={() => {
            setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));
            setSelectedDateKey(null);
          }}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Next →
        </button>
        <button
          onClick={() => {
            setViewMonth(startOfMonth(new Date()));
            setSelectedDateKey(null);
          }}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Today
        </button>
        {calendarQuery.isFetching && <span className="text-xs text-slate-500">Loading…</span>}
      </div>

      {calendarQuery.error && <p className="mb-4 text-red-400">Couldn't load the calendar.</p>}

      <div className="grid grid-cols-7 gap-1 text-xs">
        {WEEKDAY_HEADERS.map((d) => (
          <div key={d} className="px-2 py-1 text-center font-medium text-slate-500">
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
              className={`flex min-h-[4.5rem] flex-col rounded-md border p-1.5 text-left transition-colors ${
                isSelected
                  ? "border-indigo-500 bg-indigo-950/40"
                  : "border-slate-800 bg-slate-900 hover:border-slate-700"
              } ${!inMonth ? "opacity-40" : ""}`}
            >
              <span className={`text-xs ${isToday ? "font-semibold text-indigo-400" : "text-slate-400"}`}>
                {day.getDate()}
              </span>
              <div className="mt-1 flex flex-1 flex-col gap-0.5 overflow-hidden">
                {dayEvents.slice(0, 3).map((e) => (
                  <span
                    key={e.id}
                    className={`truncate rounded px-1 text-[10px] ${
                      e.isPast ? "bg-slate-800 text-slate-500" : "bg-indigo-900/60 text-indigo-200"
                    }`}
                  >
                    {e.icon} {e.name}
                  </span>
                ))}
                {dayEvents.length > 3 && (
                  <span className="text-[10px] text-slate-500">+{dayEvents.length - 3} more</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {selectedDateKey && (
        <div className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-300">
            {new Date(`${selectedDateKey}T00:00:00`).toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </h2>
          {selectedEvents.length === 0 ? (
            <p className="text-sm text-slate-500">No events this day.</p>
          ) : (
            <ul className="space-y-2">
              {selectedEvents.map((e) => (
                <li key={e.id} className="flex items-center gap-3 text-sm">
                  <span
                    className={`w-14 shrink-0 text-xs ${e.isPast ? "text-slate-500" : "text-slate-400"}`}
                  >
                    {new Date(e.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span>{e.icon}</span>
                  <span className={e.isPast ? "text-slate-400" : "text-slate-200"}>{e.name}</span>
                  {e.isPast && (
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">Past</span>
                  )}
                  {e.channelId && <span className="text-xs text-slate-500">#{e.channelId}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Layout>
  );
}
