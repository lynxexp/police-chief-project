import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Layout from "../components/Layout";
import { getAuditLog, getAppAuditLog } from "../api/client";
import { EmptyState, ErrorState, LoadingRows, Pill, buttonSecondary } from "../components/ui";

const PAGE_SIZE = 10;

type Tab = "permissions" | "activity";

function Pager({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center gap-3 text-sm text-ink-muted">
      <button onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0} className={`${buttonSecondary} disabled:opacity-40`}>
        ← Prev
      </button>
      <span className="font-mono text-xs">
        Page {page + 1} of {totalPages}
      </span>
      <button onClick={() => onPage(page + 1 < totalPages ? page + 1 : page)} disabled={page + 1 >= totalPages} className={`${buttonSecondary} disabled:opacity-40`}>
        Next →
      </button>
    </div>
  );
}

function PermissionsTab() {
  const [page, setPage] = useState(0);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-audit-log", page],
    queryFn: () => getAuditLog(page * PAGE_SIZE, PAGE_SIZE),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      {isLoading && <LoadingRows rows={5} />}
      {error && <ErrorState message="Couldn't load the audit log." onRetry={refetch} />}
      {data && data.rows.length === 0 && <EmptyState>No admin changes recorded yet.</EmptyState>}

      {data && data.rows.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Actor</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Target</th>
                  <th className="px-4 py-2 font-medium">Before</th>
                  <th className="px-4 py-2 font-medium">After</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {data.rows.map((row, i) => (
                  <tr key={i} className={i % 2 === 1 ? "bg-surface-panel-alt" : undefined}>
                    <td className="px-4 py-2 font-mono whitespace-nowrap text-ink-faint">{new Date(row.timestamp).toLocaleString()}</td>
                    <td className="px-4 py-2 text-gold-ink">{row.actorName ?? row.actorId}</td>
                    <td className="px-4 py-2 text-ink-secondary">{row.action}</td>
                    <td className="px-4 py-2 text-gold-ink">{row.targetName ?? row.targetId}</td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-muted">{row.beforeState ?? "—"}</td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-muted">{row.afterState ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} totalPages={totalPages} onPage={setPage} />
        </div>
      )}
    </>
  );
}

function ActivityTab() {
  const [page, setPage] = useState(0);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-app-audit-log", page],
    queryFn: () => getAppAuditLog(page * PAGE_SIZE, PAGE_SIZE),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      {isLoading && <LoadingRows rows={5} />}
      {error && <ErrorState message="Couldn't load the activity log." onRetry={refetch} />}
      {data && data.rows.length === 0 && <EmptyState>No activity recorded yet.</EmptyState>}

      {data && data.rows.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Actor</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Resource</th>
                  <th className="px-4 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {data.rows.map((row, i) => (
                  <tr key={i} className={i % 2 === 1 ? "bg-surface-panel-alt" : undefined}>
                    <td className="px-4 py-2 font-mono whitespace-nowrap text-ink-faint">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2 text-gold-ink">{row.actorName ?? row.actorId}</td>
                    <td className="px-4 py-2 text-ink-secondary">{row.action}</td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-muted">
                      {row.resourceType}
                      {row.resourceId ? ` #${row.resourceId}` : ""}
                    </td>
                    <td className="px-4 py-2 text-ink-muted">{row.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} totalPages={totalPages} onPage={setPage} />
        </div>
      )}
    </>
  );
}

export default function AdminAuditLog() {
  const [tab, setTab] = useState<Tab>("permissions");

  return (
    <Layout title="Audit log" backTo={{ to: "/admin/permissions", label: "Admins" }}>
      <div role="tablist" className="flex gap-2">
        <Pill active={tab === "permissions"} onClick={() => setTab("permissions")}>
          Permission changes
        </Pill>
        <Pill active={tab === "activity"} onClick={() => setTab("activity")}>
          Activity
        </Pill>
      </div>

      {tab === "permissions" ? <PermissionsTab /> : <ActivityTab />}
    </Layout>
  );
}
