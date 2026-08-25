import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { getOwnProfile } from "../api/client";

/** Landing page: the caller's own linked fids, each a doorway into that
 * alliance's roster/trends -- not a "my stats" dead end, since alliance
 * data is open to every member (see routes/member.ts's doc comment). */
export default function Profile() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["profile"],
    queryFn: getOwnProfile,
  });

  return (
    <Layout title="Your profile">
      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-red-400">Couldn't load your profile.</p>}
      {data && data.length === 0 && (
        <p className="text-slate-400">
          No characters are linked to your Discord account yet.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {data?.map((entry) => (
          <div
            key={entry.fid}
            className="rounded-lg border border-slate-800 bg-slate-900 p-5"
          >
            <div className="flex items-baseline justify-between">
              <h2 className="font-medium">{entry.nickname ?? `fid ${entry.fid}`}</h2>
              {!entry.isActive && (
                <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                  inactive
                </span>
              )}
            </div>
            <dl className="mt-3 space-y-1 text-sm text-slate-400">
              <div className="flex justify-between">
                <dt>Alliance</dt>
                <dd className="text-slate-200">{entry.allianceName ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Chief office level</dt>
                <dd className="text-slate-200">{entry.chiefOfficeLv ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Power</dt>
                <dd className="text-slate-200">{entry.power ?? "—"}</dd>
              </div>
            </dl>
            {entry.allianceId !== null && (
              <Link
                to={`/alliance/${entry.allianceId}`}
                className="mt-4 inline-block text-sm text-indigo-400 hover:text-indigo-300"
              >
                View alliance →
              </Link>
            )}
          </div>
        ))}
      </div>
    </Layout>
  );
}
