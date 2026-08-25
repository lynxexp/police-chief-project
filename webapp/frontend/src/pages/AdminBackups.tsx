import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Layout from "../components/Layout";
import { getBackups, createBackup } from "../api/client";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Owner-only. Backup + list only -- no restore here, deliberately (see
 * routes/backups.ts's doc comment). Restoring stays a manual/Discord-side
 * action; this page only ever adds new snapshots, never touches
 * existing db/ files. */
export default function AdminBackups() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-backups"],
    queryFn: getBackups,
  });

  const createMutation = useMutation({
    mutationFn: createBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-backups"] }),
  });

  return (
    <Layout title="Backups" backTo={{ to: "/admin", label: "Admin" }}>
      <div className="mb-6">
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {createMutation.isPending ? "Creating…" : "Create backup"}
        </button>
        {createMutation.isSuccess && (
          <span className="ml-3 text-sm text-emerald-400">
            Created {createMutation.data.filename}
          </span>
        )}
        {createMutation.isError && (
          <span className="ml-3 text-sm text-red-400">Backup failed.</span>
        )}
      </div>

      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-red-400">Couldn't load backups.</p>}
      {data && data.length === 0 && <p className="text-slate-400">No backups yet.</p>}

      {data && data.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {data.map((b) => (
                <tr key={b.name} className="hover:bg-slate-900/60">
                  <td className="px-4 py-2 font-mono">{b.name}</td>
                  <td className="px-4 py-2 text-slate-300">{formatBytes(b.sizeBytes)}</td>
                  <td className="px-4 py-2 text-slate-300">
                    {new Date(b.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
}
