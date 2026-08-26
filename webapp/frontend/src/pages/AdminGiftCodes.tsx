import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Layout from "../components/Layout";
import { getAdminGiftCodes, addGiftCode, updateGiftCode } from "../api/client";
import { Badge, Card, ErrorState, LoadingState, SectionHeading, buttonPrimary } from "../components/ui";

/** Global/Owner only, server-gated -- adding a code here gets announced to
 * Discord within about a minute by the bot's own polling loop (see
 * routes/giftcodes.ts's doc comment); deactivating/editing an existing code
 * is DB-only and never re-announces. Per-alliance announcement channel
 * lives on the Channel setup page instead, since that's alliance-scoped
 * and this is global. */
const todayIso = new Date().toISOString().slice(0, 10);

export default function AdminGiftCodes() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
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

  return (
    <Layout title="Gift codes" backTo={{ to: "/admin", label: "Admin" }}>
      <Card className="mb-8 max-w-lg">
        <SectionHeading>Add code</SectionHeading>
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Code
              <input
                placeholder="Code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Note (optional)
              <input
                placeholder="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              {/* type="date" inputs ignore the placeholder attribute in every
               * browser -- an explicit label is the only way this field is
               * visible at all, unlike the text inputs above it. */}
              Expiry date (optional)
              <input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
          <button
            onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending || !code.trim()}
            className={buttonPrimary}
          >
            Add
          </button>
          {addMutation.isError && (
            <p className="text-xs text-red-400">{(addMutation.error as Error).message}</p>
          )}
        </div>
      </Card>

      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load gift codes." />}

      {data && (
        <>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by code or note…"
            className="mb-3 w-full max-w-sm rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
          />
          {filtered.length === 0 && data.length > 0 && (
            <p className="mb-3 text-sm text-slate-500">No codes match "{search}".</p>
          )}
          {data.length === 0 && (
            <p className="mb-3 text-sm text-slate-500">No gift codes yet.</p>
          )}
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Note</th>
                <th className="px-4 py-2 font-medium">Expires</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((c) => (
                <tr key={c.giftcode} className="hover:bg-slate-900/60">
                  <td className="px-4 py-2 font-mono">{c.giftcode}</td>
                  <td className="px-4 py-2 text-slate-300">{c.note ?? "—"}</td>
                  <td className="px-4 py-2 text-slate-300">
                    {c.expiryDate ?? "—"}
                    {c.expiryDate && c.expiryDate < todayIso && (
                      <span className="ml-1.5 text-xs text-amber-400">(expired, hidden from members)</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={c.isActive ? "success" : "neutral"}>
                      {c.isActive ? "active" : "inactive"}
                    </Badge>
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
                      className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
                    >
                      {c.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </Layout>
  );
}
