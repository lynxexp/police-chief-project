import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getTheme, updateTheme, type ThemeDetail } from "../api/client";
import { ICON_CATEGORIES, DIVIDER_INDICES, COLOR_FIELDS } from "../theming/icons";
import { buildThemePreview, PREVIEW_PAGE_TITLES } from "../theming/preview";
import DiscordEmbedPreview from "../components/DiscordEmbedPreview";
import { Card, ErrorState, LoadingState, Pill, buttonPrimary, buttonSecondary } from "../components/ui";

const DIVIDER_SUBFIELDS = ["Start", "Pattern", "End", "Length", "CodeBlock"] as const;
const DIVIDER_KEYS = DIVIDER_INDICES.flatMap((i) => DIVIDER_SUBFIELDS.map((f) => `divider${f}${i}`));
const ICON_KEYS = Object.values(ICON_CATEGORIES).flat();
const EDITABLE_KEYS = new Set([...ICON_KEYS, ...DIVIDER_KEYS, ...COLOR_FIELDS.map((c) => c.key), "themeDescription"]);
const CATEGORIES = Object.keys(ICON_CATEGORIES);

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

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-theme", themeName],
    queryFn: () => getTheme(themeName),
  });

  const [draft, setDraft] = useState<ThemeDetail | null>(null);
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const [previewPage, setPreviewPage] = useState(0);
  const [category, setCategory] = useState(CATEGORIES[0]);

  const isDirty = useMemo(() => {
    if (!draft || !data) return false;
    for (const key of EDITABLE_KEYS) {
      if (draft[key] !== data[key]) return true;
    }
    return false;
  }, [draft, data]);

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

  const fieldInput = "w-full rounded-control border border-line bg-surface-sunken px-2.5 py-1.5 text-sm text-ink focus:border-line-strong";

  return (
    <Layout
      title={`Theme: ${themeName}`}
      backTo={{ to: "/admin/themes", label: "Themes" }}
      actions={
        draft && (
          <div className="flex items-center gap-3">
            {isDirty && <span className="font-mono text-xs text-down-ink uppercase">Unsaved changes</span>}
            <button
              onClick={() => saveMutation.mutate()}
              disabled={!isDirty || saveMutation.isPending}
              className={isDirty ? buttonPrimary : `${buttonSecondary} text-ink-disabled`}
            >
              Save
            </button>
            {saveMutation.isSuccess && !isDirty && <span className="font-mono text-xs text-up-ink">Saved</span>}
            {saveMutation.isError && <span className="font-mono text-xs text-down-ink">Couldn't save</span>}
          </div>
        )
      }
    >
      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load theme." onRetry={refetch} />}

      {draft && (
        <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
          <div className="flex flex-col gap-4">
            <label className="block">
              <span className="mb-1 block text-sm text-ink-secondary">Description</span>
              <input
                value={(draft.themeDescription as string) ?? ""}
                onChange={(e) => set("themeDescription", e.target.value)}
                className="w-full max-w-md rounded-control border border-line bg-surface-sunken px-3 py-2 text-sm text-ink"
              />
            </label>

            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <Pill key={c} active={category === c} onClick={() => setCategory(c)}>
                  {c} ({ICON_CATEGORIES[c].length})
                </Pill>
              ))}
            </div>

            <Card>
              <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                {ICON_CATEGORIES[category].map((iconKey) => (
                  <label key={iconKey} className="grid grid-cols-[1fr_200px] items-center gap-2">
                    <span className="truncate text-sm text-ink-secondary">{iconLabel(iconKey)}</span>
                    <input
                      value={(draft[iconKey] as string) ?? ""}
                      onChange={(e) => set(iconKey, e.target.value)}
                      className={`${fieldInput} font-mono text-center`}
                    />
                  </label>
                ))}
              </div>
            </Card>

            <Card>
              <p className="mb-3 font-display text-[15px] font-semibold tracking-heading text-ink uppercase">Embed colour</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {COLOR_FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <span className="mb-1 block text-xs text-ink-muted">{label}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={(draft[key] as string) || "#000000"}
                        onChange={(e) => set(key, e.target.value)}
                        className="h-[34px] w-[34px] rounded-control border border-line"
                      />
                      <input value={(draft[key] as string) ?? ""} onChange={(e) => set(key, e.target.value)} className={`${fieldInput} font-mono`} />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <p className="mb-3 font-display text-[15px] font-semibold tracking-heading text-ink uppercase">Dividers</p>
              <div className="flex flex-col gap-3">
                {DIVIDER_INDICES.map((i) => (
                  <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <label className="block">
                      <span className="mb-1 block text-xs text-ink-muted">Start {i}</span>
                      <input value={(draft[`dividerStart${i}`] as string) ?? ""} onChange={(e) => set(`dividerStart${i}`, e.target.value)} className={fieldInput} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-ink-muted">Pattern {i}</span>
                      <input value={(draft[`dividerPattern${i}`] as string) ?? ""} onChange={(e) => set(`dividerPattern${i}`, e.target.value)} className={fieldInput} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-ink-muted">End {i}</span>
                      <input value={(draft[`dividerEnd${i}`] as string) ?? ""} onChange={(e) => set(`dividerEnd${i}`, e.target.value)} className={fieldInput} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-ink-muted">Length {i}</span>
                      <input
                        type="number"
                        min={0}
                        value={(draft[`dividerLength${i}`] as number) ?? 0}
                        onChange={(e) => set(`dividerLength${i}`, Number(e.target.value))}
                        className={fieldInput}
                      />
                    </label>
                    <label className="flex items-end gap-1.5 pb-1.5 text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        checked={Boolean(draft[`dividerCodeBlock${i}`])}
                        onChange={(e) => set(`dividerCodeBlock${i}`, e.target.checked ? 1 : 0)}
                        className="rounded border-line bg-surface-sunken"
                      />
                      Code block
                    </label>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="lg:sticky lg:top-4 lg:h-fit">
            <Card>
              <div className="mb-3 flex items-center justify-between">
                <p className="font-mono text-xs font-bold tracking-pill text-gold-ink uppercase">
                  Live preview · {previewPage + 1} of {PREVIEW_PAGE_TITLES.length}
                </p>
                <div className="flex gap-1">
                  <button
                    onClick={() => setPreviewPage((p) => Math.max(0, p - 1))}
                    disabled={previewPage === 0}
                    aria-label="Previous preview"
                    className="grid h-7 w-7 place-items-center rounded-control border border-line-strong text-ink-secondary disabled:opacity-30"
                  >
                    ←
                  </button>
                  <button
                    onClick={() => setPreviewPage((p) => Math.min(PREVIEW_PAGE_TITLES.length - 1, p + 1))}
                    disabled={previewPage === PREVIEW_PAGE_TITLES.length - 1}
                    aria-label="Next preview"
                    className="grid h-7 w-7 place-items-center rounded-control border border-line-strong text-ink-secondary disabled:opacity-30"
                  >
                    →
                  </button>
                </div>
              </div>
              <DiscordEmbedPreview embed={buildThemePreview(previewPage, draft)} applyPlaceholders={false} />
              <p className="mt-3 border-t border-line-hairline pt-3 text-xs text-ink-faint">
                {PREVIEW_PAGE_TITLES[previewPage]}. The preview updates as you type. Nothing persists until you hit Save.
              </p>
              <p className="mt-2 font-mono text-[11px] text-ink-faint">The bot is currently posting with theme: {themeName}</p>
            </Card>
          </div>
        </div>
      )}
    </Layout>
  );
}
