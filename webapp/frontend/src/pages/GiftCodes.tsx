import { useQuery } from "@tanstack/react-query";
import Layout from "../components/Layout";
import { getGiftCodes } from "../api/client";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/ui";

export default function GiftCodes() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["gift-codes"],
    queryFn: getGiftCodes,
  });

  return (
    <Layout title="Gift codes" backTo={{ to: "/", label: "Your profile" }}>
      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load gift codes." />}
      {data && data.length === 0 && <EmptyState icon="🎁">No active codes right now.</EmptyState>}

      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((c) => (
          <Card key={c.giftcode}>
            <div className="font-mono text-lg text-indigo-300">{c.giftcode}</div>
            {c.note && <p className="mt-1 text-sm text-slate-400">{c.note}</p>}
            {c.expiryDate && (
              <p className="mt-2 text-xs text-slate-500">Expires {c.expiryDate}</p>
            )}
          </Card>
        ))}
      </div>
    </Layout>
  );
}
