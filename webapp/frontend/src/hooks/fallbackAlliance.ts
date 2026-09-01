import { useQuery } from "@tanstack/react-query";
import { getOwnProfile, getAdminAlliances, type OwnProfileEntry } from "../api/client";

/**
 * "The user's alliance" when there's no :allianceId route param to read
 * one from -- chiefly the profile page itself, which is also the first
 * screen after login, so anywhere nav needs an alliance in scope (the
 * mobile bottom tabs, the sidebar's "This alliance"/"Manage this
 * alliance" sections) would otherwise just disappear or dead-end there.
 *
 * Two independent fallbacks, since they answer different questions:
 *  - `played`: the alliance of whichever linked character has the most
 *    power (the same "primary character" Profile.tsx itself
 *    highlights) -- for member-facing nav (Overview/Leaderboard/etc).
 *  - `managed`: the alliance an admin administers, when they administer
 *    exactly one -- for admin-facing nav ("Manage this alliance"). An
 *    admin doesn't necessarily have a played character in the alliance
 *    they manage, so this can't reuse `played`.
 *
 * Both share their respective page's own query (["profile"] /
 * ["admin-alliances"]) via the same query key, so this costs no extra
 * fetch when that page is actually mounted -- React Query dedupes by key.
 */
export function useFallbackAllianceIds(opts: { enabled: boolean; isAdmin: boolean }): {
  played: number | null;
  managed: number | null;
} {
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: getOwnProfile,
    enabled: opts.enabled,
    staleTime: 5 * 60 * 1000,
  });
  const adminAlliancesQuery = useQuery({
    queryKey: ["admin-alliances"],
    queryFn: getAdminAlliances,
    enabled: opts.enabled && opts.isAdmin,
    staleTime: 5 * 60 * 1000,
  });

  const played =
    (profileQuery.data ?? [])
      .filter((e) => e.allianceId !== null)
      .reduce<OwnProfileEntry | null>((best, e) => (best === null || (e.power ?? 0) > (best.power ?? 0) ? e : best), null)
      ?.allianceId ?? null;

  const managed = adminAlliancesQuery.data?.length === 1 ? adminAlliancesQuery.data[0].allianceId : null;

  return { played, managed };
}
