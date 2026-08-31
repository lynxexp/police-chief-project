import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { getGuilds, setActiveGuild } from "../api/client";
import { ErrorState, LoadingState, Shield } from "../components/ui";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

/**
 * Only reachable for a Server-tier admin who belongs to more than one
 * guild with an alliance registered on it (see ProtectedRoute and
 * auth/context.ts's needsGuildSelection). Every other tier never lands
 * here. Every guild returned here already has an alliance registered
 * (selectableGuilds already intersects on that), so there's no
 * "nothing to manage on this guild" case to represent.
 *
 * Same radial-gradient field as sign-in, deliberately dark in both
 * colour modes -- both gradient stops and every text colour here are
 * fixed hexes, not text-ink/surface-* tokens, which would go dark-on-
 * dark the moment the OS is in light mode.
 */
export default function GuildSelect() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: guilds, isLoading, error } = useQuery({
    queryKey: ["guilds"],
    queryFn: getGuilds,
  });

  const mutation = useMutation({
    mutationFn: setActiveGuild,
    onSuccess: async (ctx) => {
      queryClient.setQueryData(["me"], ctx);
      navigate("/", { replace: true });
    },
  });

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-6 px-4"
      style={{ background: "radial-gradient(120% 90% at 50% 0%, #16202B 0%, #0B0F14 70%)" }}
    >
      <Shield size={64} tone="gold">
        PC
      </Shield>
      <div className="text-center">
        <h1 className="font-display text-[28px] font-bold tracking-title text-[#F4F7FA] uppercase">Which server?</h1>
        <p className="mt-1 max-w-sm text-sm text-[#8B98A6]">
          You administer alliances on more than one Discord server. Pick which one you want to manage.
        </p>
      </div>

      {isLoading && <LoadingState label="Loading servers…" />}
      {error && <ErrorState message="Couldn't load your servers. Try again." />}

      <div className="flex w-full max-w-sm flex-col gap-2">
        {guilds?.map((guild) => (
          <button
            key={guild.id}
            onClick={() => mutation.mutate(guild.id)}
            disabled={mutation.isPending}
            className="flex min-h-12 items-center gap-3 rounded-card border border-[#263341] bg-[#141B23] px-4 py-2.5 text-left hover:border-[#33475B] disabled:opacity-50"
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-control bg-white/[.06] font-display text-sm font-bold text-[#F2D97A]">
              {initials(guild.name)}
            </span>
            <span className="flex-1 truncate text-sm font-medium text-[#F4F7FA]">{guild.name}</span>
            <ChevronRight size={16} strokeWidth={1.75} className="text-[#7B8896]" aria-hidden="true" />
          </button>
        ))}
      </div>

      {mutation.isError && <ErrorState message="Couldn't select that server. Try again." />}
    </div>
  );
}
