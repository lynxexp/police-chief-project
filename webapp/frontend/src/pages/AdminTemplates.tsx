import { useQuery } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import Layout from "../components/Layout";
import { getTemplates, type AuthContext } from "../api/client";

export default function AdminTemplates() {
  const ctx = useOutletContext<AuthContext>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-templates"],
    queryFn: getTemplates,
    enabled: ctx.isGlobal,
  });

  return (
    <Layout title="Notification templates" backTo={{ to: "/admin", label: "Admin" }}>
      {!ctx.isGlobal && <p className="text-slate-400">Global admin required.</p>}

      {ctx.isGlobal && (
        <>
          <div className="mb-4">
            <Link
              to="/admin/templates/new"
              className="inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              + New template
            </Link>
          </div>

          {isLoading && <p className="text-slate-400">Loading…</p>}
          {error && <p className="text-red-400">Couldn't load templates.</p>}
          {data && data.length === 0 && (
            <p className="text-slate-400">
              No templates yet. Templates are a web-only convenience for pre-filling the notification
              create form -- the bot itself has no way to create one.
            </p>
          )}

          {data && data.length > 0 && (
            <div className="space-y-2">
              {data.map((t) => (
                <Link
                  key={t.templateId}
                  to={`/admin/templates/${t.templateId}`}
                  className="block rounded-lg border border-slate-800 bg-slate-900 p-4 hover:border-slate-700"
                >
                  <div className="font-medium">{t.templateName}</div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    {t.eventType && <span>{t.eventType}</span>}
                    {t.notificationType && <span>Type {t.notificationType}</span>}
                    {t.embedTitle && <span>{t.embedTitle}</span>}
                  </div>
                  {t.description && <div className="mt-1 text-sm text-slate-400">{t.description}</div>}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </Layout>
  );
}
