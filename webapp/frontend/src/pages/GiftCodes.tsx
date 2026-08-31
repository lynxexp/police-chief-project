import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check } from "lucide-react";
import Layout from "../components/Layout";
import { getGiftCodes, type GiftCode } from "../api/client";
import { Card, EmptyState, ErrorState, LoadingRows, buttonPrimary, buttonSecondary } from "../components/ui";

function daysUntil(dateStr: string): number {
  const ms = new Date(`${dateStr}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0);
  return Math.round(ms / 86_400_000);
}

function CodeCard({ code, isSoonestExpiring }: { code: GiftCode; isSoonestExpiring: boolean }) {
  const [copied, setCopied] = useState(false);
  const expiringSoon = code.expiryDate !== null && daysUntil(code.expiryDate) <= 3;

  function copy() {
    navigator.clipboard.writeText(code.giftcode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="overflow-hidden rounded-card border border-line">
      <div
        className={`flex items-center justify-between px-4 py-2 font-mono text-[11px] font-bold tracking-pill uppercase ${
          expiringSoon
            ? "bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] text-on-gold"
            : "bg-[#1D2833] text-rail-text"
        }`}
      >
        <span>{code.expiryDate ? `Expires ${code.expiryDate}` : "No expiry"}</span>
        {code.date && <span>Added {code.date}</span>}
      </div>
      <div className="flex flex-col gap-3 bg-surface-panel p-[18px]">
        <p className="break-all font-mono text-[26px] font-bold tracking-[.1em] text-ink">{code.giftcode}</p>
        {code.note && <p className="text-[13px] text-ink-muted">{code.note}</p>}
        <div className="flex gap-2 max-sm:flex-col">
          <button onClick={copy} className={`${buttonSecondary} max-sm:min-h-[48px] max-sm:flex-1`}>
            {copied ? <Check size={16} strokeWidth={1.75} className="mr-1.5" aria-hidden="true" /> : <Copy size={16} strokeWidth={1.75} className="mr-1.5" aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={copy}
            className={`${isSoonestExpiring ? buttonPrimary : buttonSecondary} max-sm:min-h-[48px] max-sm:flex-1`}
          >
            Redeem now
          </button>
        </div>
      </div>
    </div>
  );
}

export default function GiftCodes() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["gift-codes"],
    queryFn: getGiftCodes,
  });

  const soonestExpiringCode = data
    ?.filter((c) => c.expiryDate !== null)
    .sort((a, b) => a.expiryDate!.localeCompare(b.expiryDate!))[0]?.giftcode;

  return (
    <Layout title="Gift codes" backTo={{ to: "/", label: "Your profile" }}>
      <Card className="border-info-ink/30 bg-info-ink/[.06]">
        <p className="text-sm text-ink-secondary">
          The bot can't redeem a code on your behalf — copy it and enter it in-game yourself, under Settings →
          Gift Code.
        </p>
      </Card>

      {isLoading && <LoadingRows rows={3} />}
      {error && <ErrorState message="Couldn't load gift codes." onRetry={refetch} />}
      {data && data.length === 0 && <EmptyState>No active codes right now.</EmptyState>}

      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((c) => <CodeCard key={c.giftcode} code={c} isSoonestExpiring={c.giftcode === soonestExpiringCode} />)}
      </div>
    </Layout>
  );
}
