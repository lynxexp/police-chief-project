import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, TriangleAlert } from "lucide-react";
import Layout from "../components/Layout";
import {
  getSystemStatus,
  setUpdateCheckEnabled,
  runBotCommand,
  getWatchtowerMode,
  setWatchtowerMode,
  type BotCommand,
  type StatusCheck,
  type SystemStatusResponse,
  type WatchtowerMode,
} from "../api/client";
import { Badge, Card, ErrorState, LoadingState, SectionHeading, Shield, Toggle, buttonDanger, buttonPrimary, buttonSecondary } from "../components/ui";

// GitHub release tags are always "v0.1.2"; the running version (read
// straight from the `version` file) never has the "v" -- comparing them
// raw made an up-to-date install show "Update available" for its own
// version. Strip the prefix on both sides before comparing, same as the
// bot's own _run_update_check() already does for its DM-notification
// decision (cogs/bot_health.py) -- this just brings the web badge in
// line with that, rather than redoing the comparison differently here.
function isUpdateAvailable(version: string, latestTag: string): boolean {
  return latestTag.replace(/^v/i, "") !== version.replace(/^v/i, "");
}

function statusBadge(status: string) {
  if (status === "healthy") return <Badge variant="success">Healthy</Badge>;
  if (status === "warning") return <Badge variant="warning">Warning</Badge>;
  if (status === "error") return <Badge variant="danger">Error</Badge>;
  return <Badge>{status}</Badge>;
}

const STATUS_BORDER: Record<string, string> = {
  healthy: "border-[#2F6B4F]",
  warning: "border-gold-border",
  error: "border-down-border",
};
const STATUS_INK: Record<string, string> = {
  healthy: "text-up-ink",
  warning: "text-gold-ink",
  error: "text-down-ink",
};

function StatusTile({ label, status, detail }: { label: string; status: string; detail?: string }) {
  return (
    <div className={`flex flex-col gap-1 rounded-card border p-3.5 ${STATUS_BORDER[status] ?? "border-line"}`}>
      <p className="font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">{label}</p>
      <p className={`font-display text-lg font-bold uppercase ${STATUS_INK[status] ?? "text-ink"}`}>{status}</p>
      {detail && <p className="truncate text-xs text-ink-muted">{detail}</p>}
    </div>
  );
}

function CheckRow({ label, check }: { label: string; check: StatusCheck }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="flex items-center gap-2 text-right text-ink-secondary">
        {check.message && <span>{check.message}</span>}
        {statusBadge(check.status)}
      </span>
    </div>
  );
}

function useSecondsAgo(iso: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!iso) return 0;
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
}

const COMMAND_LABELS: Record<BotCommand, string> = {
  run_cleanup: "Run Cleanup",
  reload_cogs: "Reload All Cogs",
  clear_queue: "Clear Queue",
  restart: "Restart Bot",
  check_updates: "Check Now",
  run_update: "Update",
};

/** Owner-only. Mirrors the Discord bot's /health dashboard -- see
 * routes/systemHealth.ts's doc comment for why this reads a snapshot the
 * bot itself computes rather than re-deriving any health check here. */
export default function AdminSystemHealth() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-system-status"],
    queryFn: getSystemStatus,
    refetchInterval: 15_000,
  });

  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const [lastResult, setLastResult] = useState<{ command: BotCommand; message: string; isError: boolean } | null>(null);
  const secondsAgo = useSecondsAgo(data?.updatedAt);

  const watchtowerQuery = useQuery({
    queryKey: ["watchtower-mode"],
    queryFn: getWatchtowerMode,
    refetchInterval: 15_000,
  });

  const watchtowerModeMutation = useMutation({
    mutationFn: setWatchtowerMode,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["watchtower-mode"] }),
  });

  const toggleMutation = useMutation({
    mutationFn: setUpdateCheckEnabled,
    // The bot only regenerates its status snapshot every 30s, so an
    // invalidate-and-refetch here would very likely just redisplay the
    // stale value the toggle was meant to change. Patch the cache directly
    // instead -- the write itself already landed synchronously.
    onSuccess: (res) => {
      queryClient.setQueryData<SystemStatusResponse>(["admin-system-status"], (prev) =>
        prev ? { ...prev, snapshot: { ...prev.snapshot, updateCheckEnabled: res.enabled } } : prev,
      );
    },
  });

  const commandMutation = useMutation({
    mutationFn: runBotCommand,
    onSuccess: (res, command) => {
      if (res.status === "pending") {
        setLastResult({ command, message: "Still running -- check back in a moment.", isError: false });
      } else if (res.status === "error") {
        const msg = typeof res.result === "object" && res.result && "error" in res.result
          ? String((res.result as { error: unknown }).error)
          : "Failed.";
        setLastResult({ command, message: msg, isError: true });
      } else {
        setLastResult({ command, message: summarizeResult(command, res.result), isError: false });
      }
      queryClient.invalidateQueries({ queryKey: ["admin-system-status"] });
      setConfirmingRestart(false);
      setConfirmingUpdate(false);
    },
    onError: (err: Error, command) => {
      setLastResult({ command, message: err.message, isError: true });
      setConfirmingRestart(false);
      setConfirmingUpdate(false);
    },
  });

  function summarizeResult(command: BotCommand, result: unknown): string {
    if (!result || typeof result !== "object") return "Done.";
    const r = result as Record<string, unknown>;
    if (command === "run_cleanup") {
      return `Cleaned ${Number(r.db_cleaned_mb ?? 0).toFixed(1)} MB, archived ${r.logs_archived ?? 0} log(s).`;
    }
    if (command === "reload_cogs") {
      const success = Array.isArray(r.success) ? r.success.length : 0;
      const failed = Array.isArray(r.failed) ? r.failed.length : 0;
      return failed > 0 ? `Reloaded ${success}, ${failed} failed.` : `Reloaded ${success} cog(s).`;
    }
    if (command === "clear_queue") {
      return `Removed ${r.removed ?? 0} queued/failed item(s).`;
    }
    if (command === "restart") {
      return typeof r.note === "string" ? r.note : "Restarting.";
    }
    if (command === "check_updates") {
      if (!r.checked) return "Couldn't reach GitHub -- try again in a moment.";
      if (r.isNewer) return `${r.latestVersion} is available (you're on ${r.localVersion}).`;
      return `Up to date (${r.localVersion}).`;
    }
    if (command === "run_update") {
      return typeof r.message === "string" ? r.message : "Done.";
    }
    return "Done.";
  }

  const snapshot = data?.snapshot;

  return (
    <Layout
      title="System Health"
      backTo={{ to: "/admin", label: "Admin" }}
      actions={
        snapshot && (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => commandMutation.mutate("run_cleanup")} disabled={commandMutation.isPending} className={buttonSecondary}>
              {commandMutation.isPending && commandMutation.variables === "run_cleanup" ? "Running…" : "Run Cleanup"}
            </button>
            <button onClick={() => commandMutation.mutate("reload_cogs")} disabled={commandMutation.isPending} className={buttonSecondary}>
              {commandMutation.isPending && commandMutation.variables === "reload_cogs" ? "Reloading…" : "Reload All Cogs"}
            </button>
            <button onClick={() => commandMutation.mutate("clear_queue")} disabled={commandMutation.isPending} className={buttonSecondary}>
              {commandMutation.isPending && commandMutation.variables === "clear_queue" ? "Clearing…" : "Clear Queue"}
            </button>
            {confirmingRestart ? (
              <>
                <button onClick={() => commandMutation.mutate("restart")} disabled={commandMutation.isPending} className={buttonDanger}>
                  {commandMutation.isPending && commandMutation.variables === "restart" ? "Restarting…" : "Confirm Restart"}
                </button>
                <button onClick={() => setConfirmingRestart(false)} className={buttonSecondary}>
                  Cancel
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmingRestart(true)} className={buttonDanger}>
                Restart Bot
              </button>
            )}
          </div>
        )
      }
    >
      {isLoading && <LoadingState />}
      {error && (
        <Card>
          <ErrorState message={(error as Error).message || "Couldn't load system status."} />
        </Card>
      )}

      {snapshot && (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-2 font-mono text-[11px] tracking-pill text-ink-muted uppercase">
            <span className="pulse-online h-2 w-2 rounded-full bg-up-fill" aria-hidden="true" />
            <span>BOT ONLINE · UPDATED {secondsAgo}s AGO</span>
          </div>

          {snapshot.isWindowsHost && (
            <div className="flex items-start gap-3 rounded-card border border-down-border bg-down-tint p-4">
              <Shield size={46} tone="danger">
                !
              </Shield>
              <p className="text-sm text-ink-secondary">
                Restarting on Windows needs <span className="font-mono text-ink">watchdog.ps1</span> — without it the bot
                stops and doesn't come back.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatusTile label="Overall" status={snapshot.overall} />
            <StatusTile label="OCR engines" status={snapshot.ocr.status} detail={snapshot.ocr.summary} />
            <StatusTile label="Disk" status={snapshot.disk.status} detail={snapshot.disk.message} />
            <StatusTile
              label="Dependencies"
              status={snapshot.requirements.status}
              detail={snapshot.requirements.error ?? `${snapshot.requirements.ok_count}/${snapshot.requirements.total} OK`}
            />
          </div>

          <Card style={{ background: "linear-gradient(180deg, var(--rail-top), var(--rail-bottom))" }}>
            <p className="mb-1 font-display text-[17px] font-semibold tracking-heading text-[#E6EAEF] uppercase">Version</p>
            <div className="flex flex-wrap items-center gap-3">
              {snapshot.latestRelease && isUpdateAvailable(snapshot.version, snapshot.latestRelease.tag_name) ? (
                <>
                  <span className="rounded-pill bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-2 py-0.5 font-mono text-[10px] font-bold text-on-gold uppercase">
                    Update available
                  </span>
                  <span className="font-mono text-lg text-[#E6EAEF]">
                    v{snapshot.version} → <span className="text-gold-ink">{snapshot.latestRelease.tag_name}</span>
                  </span>
                  <a href={snapshot.latestRelease.html_url} target="_blank" rel="noreferrer" className="text-sm text-info-ink hover:text-text">
                    Release notes
                  </a>
                </>
              ) : (
                <>
                  <span className="font-mono text-lg text-[#E6EAEF]">v{snapshot.version}</span>
                  <Badge variant="success">Up to date</Badge>
                </>
              )}
              <button
                onClick={() => commandMutation.mutate("check_updates")}
                disabled={commandMutation.isPending}
                className={buttonSecondary}
              >
                <RotateCw size={16} strokeWidth={1.75} className="mr-1.5" aria-hidden="true" />
                {commandMutation.isPending && commandMutation.variables === "check_updates" ? "Checking…" : "Check Now"}
              </button>
            </div>

            {snapshot.latestRelease && isUpdateAvailable(snapshot.version, snapshot.latestRelease.tag_name) && (
              <div className="mt-3 flex flex-col gap-2">
                {snapshot.isContainer ? (
                  <div className="flex flex-col gap-1 text-xs text-rail-text">
                    <p>
                      Docker deployment -- a container can't rebuild its own image, so this has to happen on the host
                      (unless you've set up the optional <span className="font-mono text-[#E6EAEF]">watchtower</span> service,
                      which does this automatically within a few hours):
                    </p>
                    <p className="rounded-control bg-black/30 px-2 py-1 font-mono text-info-ink">
                      git pull && docker compose pull && docker compose up -d
                    </p>
                  </div>
                ) : confirmingUpdate ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => commandMutation.mutate("run_update")} disabled={commandMutation.isPending} className={buttonDanger}>
                      {commandMutation.isPending && commandMutation.variables === "run_update" ? "Updating…" : "Confirm Update"}
                    </button>
                    <button onClick={() => setConfirmingUpdate(false)} className={buttonSecondary}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmingUpdate(true)} className={buttonPrimary}>
                    Update
                  </button>
                )}
                {!snapshot.isContainer && confirmingUpdate && (
                  <p className="flex items-start gap-1.5 text-xs text-rail-text">
                    <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-gold-ink" aria-hidden="true" />
                    Pulls the latest code, reinstalls dependencies only if they changed, and restarts the bot.
                    {snapshot.isWindowsHost && " Windows host detected: it will stop and won't auto-restart unless watchdog.ps1 is set up."}
                  </p>
                )}
              </div>
            )}

            <div className="mt-4 flex items-center gap-3 border-t border-rail-border pt-3">
              <span className="text-sm text-rail-text">Automatic update checks</span>
              <Toggle checked={snapshot.updateCheckEnabled} onChange={(v) => toggleMutation.mutate(v)} disabled={toggleMutation.isPending} label="Automatic update checks" />
              <span className="text-xs text-rail-label">
                {snapshot.updateCheckEnabled ? "Checks GitHub every 6 hours and DMs the Global Admin." : "Not checking -- update on your own schedule."}
              </span>
            </div>

            {snapshot.isContainer && watchtowerQuery.data?.configured && (
              <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-rail-border pt-3">
                <span className="text-sm text-rail-text">Docker auto-update (watchtower)</span>
                <select
                  value={watchtowerQuery.data.mode ?? "apply"}
                  onChange={(e) => watchtowerModeMutation.mutate(e.target.value as WatchtowerMode)}
                  disabled={watchtowerModeMutation.isPending}
                  className="rounded-control border border-rail-border bg-black/30 px-3 py-1.5 text-sm text-[#E6EAEF]"
                >
                  <option value="off">Off</option>
                  <option value="monitor">Check only, don't apply</option>
                  <option value="apply">Check and auto-apply</option>
                </select>
                <span className="text-xs text-rail-label">
                  {watchtowerQuery.data.mode === "off" && "Watchtower is stopped -- no checking, no updating."}
                  {watchtowerQuery.data.mode === "monitor" && "Polls every 6h and logs what's available, never recreates a container."}
                  {(watchtowerQuery.data.mode === "apply" || !watchtowerQuery.data.mode) && "Polls every 6h and recreates a container automatically."}
                </span>
              </div>
            )}
            {snapshot.isContainer && watchtowerQuery.data && !watchtowerQuery.data.configured && (
              <p className="mt-3 border-t border-rail-border pt-3 text-xs text-rail-text">
                Docker auto-update: the optional watchtower-control service isn't configured.
              </p>
            )}
            {snapshot.isContainer && watchtowerQuery.isError && (
              <p className="mt-3 border-t border-rail-border pt-3 text-xs text-down-ink">
                Couldn't reach watchtower-control to read its current mode.
              </p>
            )}
          </Card>

          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <SectionHeading>Health</SectionHeading>
              <div className="flex flex-col gap-2">
                <CheckRow label="Overall" check={{ status: snapshot.overall }} />
                <CheckRow label="OCR engines" check={{ status: snapshot.ocr.status, message: snapshot.ocr.summary }} />
              </div>
            </Card>

            <Card>
              <SectionHeading>System</SectionHeading>
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex justify-between text-ink-secondary">
                  <span className="text-ink-muted">Uptime</span>
                  <span className="font-mono">{snapshot.system.uptime}</span>
                </div>
                <CheckRow label="Latency" check={{ status: snapshot.system.latency_status, message: `${snapshot.system.latency_ms}ms` }} />
                <div className="flex justify-between text-ink-secondary">
                  <span className="text-ink-muted">Cogs loaded</span>
                  <span className="font-mono">{snapshot.system.loaded_cogs}</span>
                </div>
                <div className="flex justify-between text-ink-secondary">
                  <span className="text-ink-muted">Python</span>
                  <span className="font-mono text-xs">
                    {snapshot.system.python_version} on {snapshot.system.platform}
                  </span>
                </div>
                {snapshot.system.memory_msg && (
                  <CheckRow label="Memory" check={{ status: snapshot.system.memory_status, message: snapshot.system.memory_msg }} />
                )}
                {snapshot.queue && (
                  <div className="flex justify-between text-ink-secondary">
                    <span className="text-ink-muted">Queue</span>
                    <span className="font-mono">
                      {snapshot.queue.queued} queued, {snapshot.queue.active} active, {snapshot.queue.failed} failed
                    </span>
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <SectionHeading>Storage</SectionHeading>
              <div className="flex flex-col gap-2">
                <CheckRow label="Disk" check={snapshot.disk} />
                <CheckRow label="Databases" check={snapshot.database} />
                <CheckRow label="Logs" check={snapshot.logs} />
                <CheckRow
                  label="Dependencies"
                  check={{
                    status: snapshot.requirements.status,
                    message: snapshot.requirements.error ?? `${snapshot.requirements.ok_count}/${snapshot.requirements.total} OK`,
                  }}
                />
              </div>
            </Card>
          </div>

          {lastResult && (
            <p className={`text-sm ${lastResult.isError ? "text-down-ink" : "text-up-ink"}`}>
              {COMMAND_LABELS[lastResult.command]}: {lastResult.message}
            </p>
          )}
          <p className="font-mono text-xs text-ink-faint">Loaded cogs: {snapshot.loadedCogs.length}</p>
        </div>
      )}
    </Layout>
  );
}
