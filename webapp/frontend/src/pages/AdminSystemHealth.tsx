import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Layout from "../components/Layout";
import {
  getSystemStatus,
  setUpdateCheckEnabled,
  runBotCommand,
  type BotCommand,
  type StatusCheck,
  type SystemStatusResponse,
} from "../api/client";
import { Badge, Card, ErrorState, LoadingState, SectionHeading, buttonDanger, buttonPrimary, buttonSecondary } from "../components/ui";

function statusBadge(status: string) {
  if (status === "healthy") return <Badge variant="success">Healthy</Badge>;
  if (status === "warning") return <Badge variant="warning">Warning</Badge>;
  if (status === "error") return <Badge variant="danger">Error</Badge>;
  return <Badge>{status}</Badge>;
}

function CheckRow({ label, check }: { label: string; check: StatusCheck }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="flex items-center gap-2 text-right text-slate-300">
        {check.message && <span>{check.message}</span>}
        {statusBadge(check.status)}
      </span>
    </div>
  );
}

const COMMAND_LABELS: Record<BotCommand, string> = {
  run_cleanup: "Run Cleanup",
  reload_cogs: "Reload All Cogs",
  clear_queue: "Clear Queue",
  restart: "Restart Bot",
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
  const [lastResult, setLastResult] = useState<{ command: BotCommand; message: string; isError: boolean } | null>(null);

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
    },
    onError: (err: Error, command) => {
      setLastResult({ command, message: err.message, isError: true });
      setConfirmingRestart(false);
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
    return "Done.";
  }

  const snapshot = data?.snapshot;

  return (
    <Layout title="System Health" backTo={{ to: "/admin", label: "Admin" }}>
      {isLoading && <LoadingState />}
      {error && (
        <Card className="mb-6">
          <ErrorState message={(error as Error).message || "Couldn't load system status."} />
        </Card>
      )}

      {snapshot && (
        <>
          <Card className="mb-6">
            <SectionHeading>Version</SectionHeading>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-slate-300">
                Running <span className="font-mono">{snapshot.version}</span>
              </span>
              {snapshot.latestRelease && snapshot.latestRelease.tag_name !== snapshot.version ? (
                <>
                  <Badge variant="info">Update available: {snapshot.latestRelease.tag_name}</Badge>
                  <a
                    href={snapshot.latestRelease.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-400 hover:text-indigo-300"
                  >
                    Release notes
                  </a>
                </>
              ) : (
                <Badge variant="success">Up to date</Badge>
              )}
            </div>

            {snapshot.latestRelease && snapshot.latestRelease.tag_name !== snapshot.version && (
              <div className="mt-3 space-y-1 text-xs text-slate-500">
                <p>To update, run one of these from the bot's folder:</p>
                <p className="rounded bg-slate-950 px-2 py-1 font-mono text-slate-300">
                  {snapshot.isWindowsHost ? "update.ps1" : "./update.sh"}
                </p>
                <p>
                  Docker: <span className="font-mono text-slate-300">git pull && docker compose up -d --build</span>
                </p>
              </div>
            )}

            <div className="mt-4 flex items-center gap-3 border-t border-slate-800 pt-3">
              <span className="text-sm text-slate-400">Automatic update checks</span>
              <button
                onClick={() => toggleMutation.mutate(!snapshot.updateCheckEnabled)}
                disabled={toggleMutation.isPending}
                className={snapshot.updateCheckEnabled ? buttonPrimary : buttonSecondary}
              >
                {snapshot.updateCheckEnabled ? "On" : "Off"}
              </button>
              <span className="text-xs text-slate-500">
                {snapshot.updateCheckEnabled
                  ? "Checks GitHub every 6 hours and DMs the Global Admin about new releases."
                  : "Not checking -- update on your own schedule instead."}
              </span>
            </div>
          </Card>

          <div className="mb-6 grid gap-4 md:grid-cols-3">
            <Card>
              <SectionHeading>Health</SectionHeading>
              <div className="space-y-2">
                <CheckRow label="Overall" check={{ status: snapshot.overall }} />
                <CheckRow label="OCR engines" check={{ status: snapshot.ocr.status, message: snapshot.ocr.summary }} />
              </div>
            </Card>

            <Card>
              <SectionHeading>System</SectionHeading>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between text-slate-300">
                  <span className="text-slate-400">Uptime</span>
                  <span>{snapshot.system.uptime}</span>
                </div>
                <CheckRow
                  label="Latency"
                  check={{ status: snapshot.system.latency_status, message: `${snapshot.system.latency_ms}ms` }}
                />
                <div className="flex justify-between text-slate-300">
                  <span className="text-slate-400">Cogs loaded</span>
                  <span>{snapshot.system.loaded_cogs}</span>
                </div>
                <div className="flex justify-between text-slate-300">
                  <span className="text-slate-400">Python</span>
                  <span>{snapshot.system.python_version} on {snapshot.system.platform}</span>
                </div>
                {snapshot.system.memory_msg && (
                  <CheckRow
                    label="Memory"
                    check={{ status: snapshot.system.memory_status, message: snapshot.system.memory_msg }}
                  />
                )}
                {snapshot.queue && (
                  <div className="flex justify-between text-slate-300">
                    <span className="text-slate-400">Queue</span>
                    <span>
                      {snapshot.queue.queued} queued, {snapshot.queue.active} active, {snapshot.queue.failed} failed
                    </span>
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <SectionHeading>Storage</SectionHeading>
              <div className="space-y-2">
                <CheckRow label="Disk" check={snapshot.disk} />
                <CheckRow label="Databases" check={snapshot.database} />
                <CheckRow label="Logs" check={snapshot.logs} />
                <CheckRow
                  label="Dependencies"
                  check={{
                    status: snapshot.requirements.status,
                    message:
                      snapshot.requirements.error ??
                      `${snapshot.requirements.ok_count}/${snapshot.requirements.total} OK`,
                  }}
                />
              </div>
            </Card>
          </div>

          <Card>
            <SectionHeading>Actions</SectionHeading>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => commandMutation.mutate("run_cleanup")}
                disabled={commandMutation.isPending}
                className={buttonSecondary}
              >
                {commandMutation.isPending && commandMutation.variables === "run_cleanup" ? "Running…" : "Run Cleanup"}
              </button>
              <button
                onClick={() => commandMutation.mutate("reload_cogs")}
                disabled={commandMutation.isPending}
                className={buttonSecondary}
              >
                {commandMutation.isPending && commandMutation.variables === "reload_cogs" ? "Reloading…" : "Reload All Cogs"}
              </button>
              <button
                onClick={() => commandMutation.mutate("clear_queue")}
                disabled={commandMutation.isPending}
                className={buttonSecondary}
              >
                {commandMutation.isPending && commandMutation.variables === "clear_queue" ? "Clearing…" : "Clear Queue"}
              </button>

              {confirmingRestart ? (
                <>
                  <button
                    onClick={() => commandMutation.mutate("restart")}
                    disabled={commandMutation.isPending}
                    className={buttonDanger}
                  >
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

            {snapshot.isWindowsHost && confirmingRestart && (
              <p className="mt-3 text-xs text-amber-400">
                Windows host detected: the bot will stop and will not auto-restart unless
                watchdog.ps1 is set up (see the Installation guide).
              </p>
            )}

            {lastResult && (
              <p className={`mt-3 text-sm ${lastResult.isError ? "text-red-400" : "text-emerald-400"}`}>
                {COMMAND_LABELS[lastResult.command]}: {lastResult.message}
              </p>
            )}

            <p className="mt-3 text-xs text-slate-500">
              Loaded cogs: {snapshot.loadedCogs.length}
            </p>
          </Card>

          <p className="mt-4 text-xs text-slate-500">
            Last updated {new Date(data.updatedAt).toLocaleTimeString()} -- refreshes automatically every 15s.
          </p>
        </>
      )}
    </Layout>
  );
}
