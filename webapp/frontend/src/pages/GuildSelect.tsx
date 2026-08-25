import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getGuilds, setActiveGuild } from "../api/client";

/**
 * Only reachable for a Server-tier admin who belongs to more than one
 * guild with an alliance registered on it (see ProtectedRoute and
 * auth/context.ts's needsGuildSelection). Every other tier never lands
 * here.
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
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-950 px-4 text-slate-100">
      <h1 className="text-xl font-semibold">Which server?</h1>
      <p className="max-w-sm text-center text-sm text-slate-400">
        You administer alliances on more than one Discord server. Pick which
        one you want to manage.
      </p>

      {isLoading && <p className="text-slate-400">Loading servers…</p>}
      {error && <p className="text-red-400">Couldn't load your servers. Try again.</p>}

      <div className="flex w-full max-w-sm flex-col gap-2">
        {guilds?.map((guild) => (
          <button
            key={guild.id}
            onClick={() => mutation.mutate(guild.id)}
            disabled={mutation.isPending}
            className="rounded-md border border-slate-700 bg-slate-900 px-4 py-2.5 text-left hover:bg-slate-800 disabled:opacity-50"
          >
            {guild.name}
          </button>
        ))}
      </div>

      {mutation.isError && (
        <p className="text-red-400">Couldn't select that server. Try again.</p>
      )}
    </div>
  );
}
