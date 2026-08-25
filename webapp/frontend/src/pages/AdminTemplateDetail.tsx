import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getTemplate, updateTemplate, deleteTemplate } from "../api/client";
import DiscordEmbedPreview from "../components/DiscordEmbedPreview";
import TemplateForm, { draftFromTemplate, draftToTemplateInput, isTemplateDraftValid } from "../components/TemplateForm";

function repeatDescription(config: { type: string; minutes?: number; days?: number[] } | null): string {
  if (!config) return "Not set";
  if (config.type === "interval") return `Every ${config.minutes} minutes`;
  if (config.type === "fixed_days") {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return `On: ${(config.days ?? []).map((d) => names[d] ?? `Day ${d}`).join(", ")}`;
  }
  return "Custom";
}

export default function AdminTemplateDetail() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = Number(idParam);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof draftFromTemplate> | null>(null);

  const templateQuery = useQuery({
    queryKey: ["admin-template", id],
    queryFn: () => getTemplate(id),
  });
  const t = templateQuery.data;

  useEffect(() => {
    if (t && !editing) setDraft(draftFromTemplate(t));
  }, [t, editing]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-template", id] });

  const saveMutation = useMutation({
    mutationFn: () => updateTemplate(id, draftToTemplateInput(draft!)),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteTemplate(id),
    onSuccess: () => navigate("/admin/templates"),
  });

  return (
    <Layout title="Template" backTo={{ to: "/admin/templates", label: "Templates" }}>
      {templateQuery.isLoading && <p className="text-slate-400">Loading…</p>}
      {templateQuery.error && <p className="text-red-400">Couldn't load this template.</p>}

      {t && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setDraft(draftFromTemplate(t));
                setEditing((v) => !v);
              }}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
            >
              {editing ? "Cancel edit" : "Edit"}
            </button>
            <button
              onClick={() => {
                if (confirm("Delete this template? This cannot be undone.")) deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50"
            >
              Delete
            </button>
          </div>

          {editing && draft ? (
            <div className="max-w-lg rounded-lg border border-indigo-900 bg-slate-900 p-4">
              <div className="mb-3 font-medium text-slate-200">Edit template</div>
              <TemplateForm draft={draft} onChange={setDraft} />
              <button
                onClick={() => saveMutation.mutate()}
                disabled={!isTemplateDraftValid(draft) || saveMutation.isPending}
                className="mt-3 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Save changes
              </button>
              {saveMutation.isError && (
                <p className="mt-2 text-sm text-red-400">{(saveMutation.error as Error).message}</p>
              )}
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                <div className="mb-3 text-lg font-medium">{t.templateName}</div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">Event name</dt>
                    <dd>{t.eventType ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Reminder offsets</dt>
                    <dd>{t.notificationType ? `Type ${t.notificationType}` : "Not set"}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-slate-500">Repeat</dt>
                    <dd>{repeatDescription(t.repeatConfig)}</dd>
                  </div>
                  {t.description && (
                    <div className="sm:col-span-2">
                      <dt className="text-slate-500">Description</dt>
                      <dd>{t.description}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-slate-500">Created by</dt>
                    <dd>{t.createdBy ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Created at</dt>
                    <dd>{t.createdAt ? new Date(t.createdAt).toLocaleString() : "—"}</dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                <div className="mb-2 font-medium text-slate-200">Embed content</div>
                <DiscordEmbedPreview
                  embed={{
                    title: t.embedTitle,
                    description: t.embedDescription,
                    color: t.embedColor,
                    imageUrl: t.embedImageUrl,
                    thumbnailUrl: t.embedThumbnailUrl,
                    footer: t.footer,
                    author: t.author,
                    mentionMessage: t.mentionMessage,
                  }}
                  applyPlaceholders={false}
                />
              </div>
            </>
          )}
        </div>
      )}
    </Layout>
  );
}
