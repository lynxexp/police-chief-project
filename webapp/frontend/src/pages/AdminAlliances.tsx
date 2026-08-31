import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import { Users, Hash, Bell, CalendarDays, ClipboardList, ChevronRight } from "lucide-react";
import Layout from "../components/Layout";
import { getAdminAlliances, getRegisterSettings, updateRegisterSettings, type AuthContext } from "../api/client";
import { Card, EmptyState, ErrorState, LoadingRows, SectionHeading, Toggle } from "../components/ui";

const DESTINATIONS = (allianceId: number) => [
  { to: `/admin/alliances/${allianceId}/members`, label: "Manage members", icon: Users },
  { to: `/admin/alliances/${allianceId}/settings`, label: "Channel setup", icon: Hash },
  { to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications", icon: Bell },
  { to: `/admin/alliances/${allianceId}/custom-events`, label: "Custom events", icon: CalendarDays },
  { to: `/admin/alliances/${allianceId}/schedule-boards`, label: "Schedule boards", icon: ClipboardList },
];

/** Entry point for admins: the alliances they can manage (all of them,
 * for Owner/Global tier -- see routes/admin.ts's getAdminAlliances). */
export default function AdminAlliances() {
  const ctx = useOutletContext<AuthContext>();
  const { data, isLoading, error, refetch } = useQuery({
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
        <div className="flex items-center justify-between gap-4 rounded-card border border-down-border bg-down-tint px-4 py-3">
          <div>
            <p className="font-mono text-[11px] font-semibold tracking-pill text-down-ink uppercase">Server-wide</p>
            <p className="mt-0.5 text-sm text-ink-secondary">Self-registration (/register) enabled bot-wide</p>
          </div>
          <Toggle
            checked={registerSettings.data.enabled}
            onChange={(v) => toggleRegister.mutate(v)}
            disabled={toggleRegister.isPending}
            label="Self-registration enabled bot-wide"
          />
        </div>
      )}

      <SectionHeading>Alliances you administer</SectionHeading>
      {isLoading && <LoadingRows rows={3} />}
      {error && <ErrorState message="Couldn't load alliances." onRetry={refetch} />}
      {data && data.length === 0 && <EmptyState>No alliances assigned to you.</EmptyState>}

      <div className="grid gap-4 sm:grid-cols-2">
        {data?.map((a) => (
          <Card key={a.allianceId} className="p-0">
            <p className="border-b border-line-hairline px-4 py-3 font-display text-lg font-semibold text-ink">
              {a.name ?? `Alliance ${a.allianceId}`}
            </p>
            <div className="flex flex-col">
              {DESTINATIONS(a.allianceId).map((d) => {
                const Icon = d.icon;
                return (
                  <Link
                    key={d.to}
                    to={d.to}
                    className="flex min-h-11 items-center gap-2.5 border-b border-line-hairline px-4 text-sm text-ink-secondary last:border-b-0 hover:bg-white/[.03] hover:text-ink"
                  >
                    <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className="flex-1">{d.label}</span>
                    <ChevronRight size={16} strokeWidth={1.75} className="text-ink-faint" aria-hidden="true" />
                  </Link>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </Layout>
  );
}
