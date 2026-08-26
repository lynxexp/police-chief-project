import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAdminAlliances,
  getRegisterSettings,
  updateRegisterSettings,
  type AuthContext,
} from "../api/client";
import { Card, EmptyState, ErrorState, LoadingState, SectionHeading } from "../components/ui";

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
      {ctx.isGlobal && registerSettings.data && (
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

      <SectionHeading>Alliances you administer</SectionHeading>
      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load alliances." />}
      {data && data.length === 0 && <EmptyState icon="🏛️">No alliances assigned to you.</EmptyState>}

      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((a) => (
          <Card key={a.allianceId}>
            <div className="font-medium">{a.name ?? `Alliance ${a.allianceId}`}</div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <Link to={`/admin/alliances/${a.allianceId}/members`} className="text-slate-500 hover:text-slate-300">
                Manage members →
              </Link>
              <Link to={`/admin/alliances/${a.allianceId}/settings`} className="text-slate-500 hover:text-slate-300">
                Channel setup →
              </Link>
              <Link to={`/admin/alliances/${a.allianceId}/notifications`} className="text-slate-500 hover:text-slate-300">
                Notifications →
              </Link>
              <Link to={`/admin/alliances/${a.allianceId}/custom-events`} className="text-slate-500 hover:text-slate-300">
                Custom events →
              </Link>
              <Link to={`/admin/alliances/${a.allianceId}/schedule-boards`} className="text-slate-500 hover:text-slate-300">
                Schedule boards →
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </Layout>
  );
}
