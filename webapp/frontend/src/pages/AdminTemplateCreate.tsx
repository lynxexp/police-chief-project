import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import { createTemplate } from "../api/client";
import TemplateForm, { defaultTemplateDraft, draftToTemplateInput, isTemplateDraftValid } from "../components/TemplateForm";

export default function AdminTemplateCreate() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(defaultTemplateDraft());

  const createMutation = useMutation({
    mutationFn: () => createTemplate(draftToTemplateInput(draft)),
    onSuccess: (result) => navigate(`/admin/templates/${result.id}`),
  });

  return (
    <Layout title="New template" backTo={{ to: "/admin/templates", label: "Templates" }}>
      <div className="max-w-lg space-y-4">
        <TemplateForm draft={draft} onChange={setDraft} />

        <button
          onClick={() => createMutation.mutate()}
          disabled={!isTemplateDraftValid(draft) || createMutation.isPending}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Create template
        </button>
        {createMutation.isError && (
          <p className="text-sm text-red-400">{(createMutation.error as Error).message}</p>
        )}
      </div>
    </Layout>
  );
}
