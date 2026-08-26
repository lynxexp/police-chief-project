import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Layout from "../components/Layout";
import { getAuditLog, getAppAuditLog } from "../api/client";
import { EmptyState, ErrorState, LoadingState } from "../components/ui";

const PAGE_SIZE = 10;

type Tab = "permissions" | "activity";

function PermissionsTab() {
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-audit-log", page],
    queryFn: () => getAuditLog(page * PAGE_SIZE, PAGE_SIZE),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load the audit log." />}
      {data && data.rows.length === 0 && <EmptyState icon="📜">No admin changes recorded yet.</EmptyState>}

      {data && data.rows.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-left text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Actor</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Target</th>
                  <th className="px-4 py-2 font-medium">Before</th>
                  <th className="px-4 py-2 font-medium">After</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {data.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-900/60">
                    <td className="px-4 py-2 whitespace-nowrap text-slate-400">
                      {new Date(row.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-2">{row.actorName ?? row.actorId}</td>
                    <td className="px-4 py-2 text-slate-300">{row.action}</td>
                    <td className="px-4 py-2">{row.targetName ?? row.targetId}</td>
                    <td className="px-4 py-2 text-slate-400">{row.beforeState ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-400">{row.afterState ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center gap-3 text-sm text-slate-400">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40"
            >
              ← Prev
            </button>
            <span>
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => (p + 1 < totalPages ? p + 1 : p))}
              disabled={page + 1 >= totalPages}
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </>
      )}
    </>
  );
}

function ActivityTab() {
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-app-audit-log", page],
    queryFn: () => getAppAuditLog(page * PAGE_SIZE, PAGE_SIZE),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load the activity log." />}
      {data && data.rows.length === 0 && <EmptyState icon="📋">No activity recorded yet.</EmptyState>}

      {data && data.rows.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-left text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Actor</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Resource</th>
                  <th className="px-4 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {data.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-900/60">
                    <td className="px-4 py-2 whitespace-nowrap text-slate-400">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2">{row.actorName ?? row.actorId}</td>
                    <td className="px-4 py-2 text-slate-300">{row.action}</td>
                    <td className="px-4 py-2 text-slate-400">
                      {row.resourceType}
                      {row.resourceId ? ` #${row.resourceId}` : ""}
                    </td>
                    <td className="px-4 py-2 text-slate-400">{row.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center gap-3 text-sm text-slate-400">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40"
            >
              ← Prev
            </button>
            <span>
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => (p + 1 < totalPages ? p + 1 : p))}
              disabled={page + 1 >= totalPages}
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </>
      )}
    </>
  );
}

export default function AdminAuditLog() {
  const [tab, setTab] = useState<Tab>("permissions");

  return (
    <Layout title="Audit log" backTo={{ to: "/admin/permissions", label: "Admins" }}>
      <div className="mb-4 flex gap-2 text-sm">
        <button
          onClick={() => setTab("permissions")}
          className={`rounded-md border px-3 py-1.5 ${
            tab === "permissions"
              ? "border-indigo-500 bg-indigo-600 text-white"
              : "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
          }`}
        >
          Permission changes
        </button>
        <button
          onClick={() => setTab("activity")}
          className={`rounded-md border px-3 py-1.5 ${
            tab === "activity"
              ? "border-indigo-500 bg-indigo-600 text-white"
              : "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
          }`}
        >
          Activity log
        </button>
      </div>

      {tab === "permissions" ? <PermissionsTab /> : <ActivityTab />}
    </Layout>
  );
}
