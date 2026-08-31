import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Layout from "../components/Layout";
import { getAdminGiftCodes, addGiftCode, updateGiftCode } from "../api/client";
import { Badge, Card, ErrorState, LoadingRows, SectionHeading, buttonPrimary, buttonSecondary } from "../components/ui";

/** Global/Owner only, server-gated -- adding a code here gets announced to
 * Discord within about a minute by the bot's own polling loop (see
 * routes/giftcodes.ts's doc comment); deactivating/editing an existing code
 * is DB-only and never re-announces. Per-alliance announcement channel
 * lives on the Channel setup page instead, since that's alliance-scoped
 * and this is global. */
const todayIso = new Date().toISOString().slice(0, 10);

export default function AdminGiftCodes() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-gift-codes"],
    queryFn: getAdminGiftCodes,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-gift-codes"] });

  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [search, setSearch] = useState("");

  const addMutation = useMutation({
    mutationFn: () => addGiftCode(code.trim(), note || null, expiryDate || null),
    onSuccess: () => {
      invalidate();
      setCode("");
      setNote("");
      setExpiryDate("");
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ giftcode, isActive }: { giftcode: string; isActive: boolean }) =>
      updateGiftCode(giftcode, { isActive }),
    onSuccess: invalidate,
  });

  const filtered = (data ?? []).filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return c.giftcode.toLowerCase().includes(q) || (c.note?.toLowerCase().includes(q) ?? false);
  });

  const inputClass = "mt-1 w-full rounded-control border border-line bg-surface-sunken px-3 py-1.5 text-sm text-ink";

  return (
    <Layout title="Gift codes" backTo={{ to: "/admin", label: "Admin" }}>
      <Card className="max-w-lg">
        <SectionHeading>Add code</SectionHeading>
        <div className="flex flex-col gap-3">
          <label className="block text-xs text-ink-muted">
            Code
            <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} className={`${inputClass} font-mono`} />
          </label>
          <label className="block text-xs text-ink-muted">
            Note (optional)
            <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
          </label>
          <label className="block text-xs text-ink-muted">
            {/* type="date" inputs ignore the placeholder attribute in every
             * browser -- an explicit label is the only way this field is
             * visible at all, unlike the text inputs above it. */}
            Expiry date (optional)
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className={inputClass} />
          </label>
          <div>
            <button onClick={() => addMutation.mutate()} disabled={addMutation.isPending || !code.trim()} className={buttonPrimary}>
              Add
            </button>
            {addMutation.isError && <p className="mt-1.5 text-xs text-down-ink">{(addMutation.error as Error).message}</p>}
          </div>
        </div>
      </Card>

      {isLoading && <LoadingRows rows={4} />}
      {error && <ErrorState message="Couldn't load gift codes." onRetry={refetch} />}

      {data && (
        <div className="flex flex-col gap-3">
          <div className="relative max-w-sm">
            <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by code or note…"
              className="w-full rounded-control border border-line bg-surface-sunken py-2 pr-3 pl-9 text-sm text-ink"
            />
          </div>
          {filtered.length === 0 && data.length > 0 && <p className="text-sm text-ink-muted">No codes match "{search}".</p>}
          {data.length === 0 && <p className="text-sm text-ink-muted">No gift codes yet.</p>}

          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-4 py-2 font-medium">Code</th>
                  <th className="px-4 py-2 font-medium">Note</th>
                  <th className="px-4 py-2 font-medium">Expires</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {filtered.map((c, i) => (
                  <tr key={c.giftcode} className={i % 2 === 1 ? "bg-surface-panel-alt" : undefined}>
                    <td className="px-4 py-2 font-mono text-ink">{c.giftcode}</td>
                    <td className="px-4 py-2 text-ink-secondary">{c.note ?? "—"}</td>
                    <td className="px-4 py-2 font-mono text-ink-secondary">
                      {c.expiryDate ?? "—"}
                      {c.expiryDate && c.expiryDate < todayIso && <span className="ml-1.5 text-xs text-gold-ink">(expired, hidden from members)</span>}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={c.isActive ? "success" : "neutral"}>{c.isActive ? "active" : "inactive"}</Badge>
                    </td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => {
                          if (c.isActive && !confirm(`Deactivate code "${c.giftcode}"? Members will no longer see it as active.`)) {
                            return;
                          }
                          toggleMutation.mutate({ giftcode: c.giftcode, isActive: !c.isActive });
                        }}
                        disabled={toggleMutation.isPending}
                        className={`${buttonSecondary} px-2 py-1 text-xs`}
                      >
                        {c.isActive ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
}
