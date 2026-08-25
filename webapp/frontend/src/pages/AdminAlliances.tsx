import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAdminAlliances,
  getRegisterSettings,
  updateRegisterSettings,
  type AuthContext,
} from "../api/client";

/** Entry point for admins: the alliances they can manage (all of them,
 * for Owner/Global tier -- see routes/admin.ts's getAdminAlliances). */
export default function AdminAlliances() {
  const ctx = useOutletContext<AuthContext>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-alliances"],
    queryFn: getAdminAlliances,
  });

  const queryClient = useQueryClient();
  const registerSettings = useQuery({
    queryKey: ["register-settings"],
    queryFn: getRegisterSettings,
    enabled: ctx.isGlobal,
  });
  const toggleRegister = useMutation({
    mutationFn: (enabled: boolean) => updateRegisterSettings(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["register-settings"] }),
  });

  return (
    <Layout title="Admin" backTo={{ to: "/", label: "Your profile" }}>
      {ctx.isGlobal && (
        <>
          <div className="mb-4 flex gap-3 text-sm">
            <Link
              to="/admin/permissions"
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
            >
              Manage admins →
            </Link>
            <Link
              to="/admin/permissions/audit-log"
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
            >
              Audit log →
            </Link>
            <Link
              to="/admin/gift-codes"
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
            >
              Gift codes →
            </Link>
            <Link
              to="/admin/themes"
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
            >
              Themes →
            </Link>
            <Link
              to="/admin/templates"
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
            >
              Templates →
            </Link>
            {ctx.isOwner && (
              <Link
                to="/admin/backups"
                className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
              >
                Backups →
              </Link>
            )}
          </div>

          {registerSettings.data && (
            <label className="mb-6 flex w-fit items-center gap-2 rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={registerSettings.data.enabled}
                onChange={(e) => toggleRegister.mutate(e.target.checked)}
                disabled={toggleRegister.isPending}
                className="rounded border-slate-700 bg-slate-950"
              />
              Self-registration (/register) enabled bot-wide
            </label>
          )}
        </>
      )}

      <h2 className="mb-3 text-sm font-medium text-slate-300">Alliances you administer</h2>
      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-red-400">Couldn't load alliances.</p>}
      {data && data.length === 0 && (
        <p className="text-slate-400">No alliances assigned to you.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((a) => (
          <Link
            key={a.allianceId}
            to={`/admin/alliances/${a.allianceId}/members`}
            className="rounded-lg border border-slate-800 bg-slate-900 p-4 hover:border-slate-700"
          >
            <div className="font-medium">{a.name ?? `Alliance ${a.allianceId}`}</div>
            <div className="mt-1 text-xs text-slate-500">Manage members →</div>
          </Link>
        ))}
      </div>
    </Layout>
  );
}
