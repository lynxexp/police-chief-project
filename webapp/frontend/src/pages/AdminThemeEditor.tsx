import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getTheme, updateTheme, type ThemeDetail } from "../api/client";
import { ICON_CATEGORIES, DIVIDER_INDICES, COLOR_FIELDS } from "../theming/icons";
import { buildThemePreview, PREVIEW_PAGE_TITLES } from "../theming/preview";
import DiscordEmbedPreview from "../components/DiscordEmbedPreview";

const DIVIDER_SUBFIELDS = ["Start", "Pattern", "End", "Length", "CodeBlock"] as const;
const DIVIDER_KEYS = DIVIDER_INDICES.flatMap((i) => DIVIDER_SUBFIELDS.map((f) => `divider${f}${i}`));
const ICON_KEYS = Object.values(ICON_CATEGORIES).flat();
const EDITABLE_KEYS = new Set([...ICON_KEYS, ...DIVIDER_KEYS, ...COLOR_FIELDS.map((c) => c.key), "themeDescription"]);

/** "shutdownSparkleIcon" -> "Shutdown Sparkle" */
function iconLabel(column: string): string {
  const stripped = column.replace(/Icon$/, "");
  const spaced = stripped.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  return spaced;
}

export default function AdminThemeEditor() {
  const { themeName: themeNameParam } = useParams<{ themeName: string }>();
  const themeName = themeNameParam ?? "";
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-theme", themeName],
    queryFn: () => getTheme(themeName),
  });

  const [draft, setDraft] = useState<ThemeDetail | null>(null);
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const [previewPage, setPreviewPage] = useState(0);

  const saveMutation = useMutation({
    mutationFn: () => {
      const patch: Record<string, string | number | boolean | null> = {};
      for (const key of EDITABLE_KEYS) {
        if (draft && key in draft) {
          patch[key] = key.startsWith("dividerCodeBlock") ? Boolean(draft[key]) : draft[key];
        }
      }
      return updateTheme(themeName, patch);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-theme", themeName] }),
  });

  const set = (key: string, value: string | number | null) => {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  };

  return (
    <Layout title={`Theme: ${themeName}`} backTo={{ to: "/admin/themes", label: "Themes" }}>
      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-red-400">Couldn't load theme.</p>}

      {draft && (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-slate-400">Description</label>
            <input
              value={(draft.themeDescription as string) ?? ""}
              onChange={(e) => set("themeDescription", e.target.value)}
              className="w-full max-w-md rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            />
          </div>

          <div className="sticky top-0 z-10 -mx-6 bg-slate-950/95 px-6 py-3 backdrop-blur">
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              Save
            </button>
            {saveMutation.isSuccess && (
              <span className="ml-3 text-sm text-emerald-400">Saved.</span>
            )}
            {saveMutation.isError && (
              <span className="ml-3 text-sm text-red-400">Couldn't save.</span>
            )}
          </div>

          <details className="rounded-lg border border-slate-800 bg-slate-900 p-4" open>
            <summary className="cursor-pointer text-sm font-medium text-slate-300">
              Preview
            </summary>
            <div className="mt-3">
              <div className="mb-3 flex items-center gap-3 text-sm">
                <button
                  onClick={() => setPreviewPage((p) => Math.max(0, p - 1))}
                  disabled={previewPage === 0}
                  className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-40"
                >
                  ← Prev
                </button>
                <span className="text-slate-400">
                  {previewPage + 1}/{PREVIEW_PAGE_TITLES.length} — {PREVIEW_PAGE_TITLES[previewPage]}
                </span>
                <button
                  onClick={() => setPreviewPage((p) => Math.min(PREVIEW_PAGE_TITLES.length - 1, p + 1))}
                  disabled={previewPage === PREVIEW_PAGE_TITLES.length - 1}
                  className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
              <DiscordEmbedPreview embed={buildThemePreview(previewPage, draft)} applyPlaceholders={false} />
              <p className="mt-2 text-xs text-slate-500">
                Preview: {PREVIEW_PAGE_TITLES[previewPage]} • Theme: {themeName}
              </p>
            </div>
          </details>

          <details className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-300">
              Colors
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {COLOR_FIELDS.map(({ key, label }) => (
                <div key={key}>
                  <label className="mb-1 block text-xs text-slate-400">{label}</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={(draft[key] as string) || "#000000"}
                      onChange={(e) => set(key, e.target.value)}
                      className="h-8 w-8 rounded border border-slate-700 bg-slate-900"
                    />
                    <input
                      value={(draft[key] as string) ?? ""}
                      onChange={(e) => set(key, e.target.value)}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                    />
                  </div>
                </div>
              ))}
            </div>
          </details>

          <details className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-300">
              Dividers
            </summary>
            <div className="mt-3 space-y-3">
              {DIVIDER_INDICES.map((i) => (
                <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Start {i}</label>
                    <input
                      value={(draft[`dividerStart${i}`] as string) ?? ""}
                      onChange={(e) => set(`dividerStart${i}`, e.target.value)}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Pattern {i}</label>
                    <input
                      value={(draft[`dividerPattern${i}`] as string) ?? ""}
                      onChange={(e) => set(`dividerPattern${i}`, e.target.value)}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">End {i}</label>
                    <input
                      value={(draft[`dividerEnd${i}`] as string) ?? ""}
                      onChange={(e) => set(`dividerEnd${i}`, e.target.value)}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Length {i}</label>
                    <input
                      type="number"
                      min={0}
                      value={(draft[`dividerLength${i}`] as number) ?? 0}
                      onChange={(e) => set(`dividerLength${i}`, Number(e.target.value))}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                    />
                  </div>
                  <label className="flex items-end gap-1 pb-1 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={Boolean(draft[`dividerCodeBlock${i}`])}
                      onChange={(e) => set(`dividerCodeBlock${i}`, e.target.checked ? 1 : 0)}
                      className="rounded border-slate-700 bg-slate-950"
                    />
                    Code block
                  </label>
                </div>
              ))}
            </div>
          </details>

          {Object.entries(ICON_CATEGORIES).map(([category, icons]) => (
            <details key={category} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-300">
                {category} <span className="text-slate-500">({icons.length})</span>
              </summary>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {icons.map((iconKey) => (
                  <div key={iconKey}>
                    <label className="mb-1 block text-xs text-slate-400">{iconLabel(iconKey)}</label>
                    <input
                      value={(draft[iconKey] as string) ?? ""}
                      onChange={(e) => set(iconKey, e.target.value)}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-center text-sm"
                    />
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </Layout>
  );
}
