import { useQuery } from "@tanstack/react-query";
import Layout from "../components/Layout";
import { getGiftCodes } from "../api/client";

export default function GiftCodes() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["gift-codes"],
    queryFn: getGiftCodes,
  });

  return (
    <Layout title="Gift codes" backTo={{ to: "/", label: "Your profile" }}>
      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-red-400">Couldn't load gift codes.</p>}
      {data && data.length === 0 && <p className="text-slate-400">No active codes right now.</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((c) => (
          <div key={c.giftcode} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="font-mono text-lg text-indigo-300">{c.giftcode}</div>
            {c.note && <p className="mt-1 text-sm text-slate-400">{c.note}</p>}
            {c.expiryDate && (
              <p className="mt-2 text-xs text-slate-500">Expires {c.expiryDate}</p>
            )}
          </div>
        ))}
      </div>
    </Layout>
  );
}
