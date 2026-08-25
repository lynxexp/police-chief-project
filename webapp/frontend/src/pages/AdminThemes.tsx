import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { getThemes, createTheme, deleteTheme, setActiveTheme } from "../api/client";

export default function AdminThemes() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-themes"],
    queryFn: getThemes,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-themes"] });

  const [newName, setNewName] = useState("");
  const createMutation = useMutation({
    mutationFn: () => createTheme(newName.trim()),
    onSuccess: () => {
      invalidate();
      setNewName("");
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (name: string) => deleteTheme(name),
    onSuccess: invalidate,
  });
  const setActiveMutation = useMutation({
    mutationFn: (name: string) => setActiveTheme(name),
    onSuccess: invalidate,
  });

  return (
    <Layout title="Themes" backTo={{ to: "/admin", label: "Admin" }}>
      <div className="mb-6 flex gap-2">
        <input
          placeholder="New theme name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
        />
        <button
          onClick={() => createMutation.mutate()}
          disabled={!newName.trim() || createMutation.isPending}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Create (clones "default")
        </button>
      </div>
      {createMutation.isError && (
        <p className="mb-4 text-sm text-red-400">{(createMutation.error as Error).message}</p>
      )}

      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-red-400">Couldn't load themes.</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((t) => (
          <div key={t.themeName} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <Link
                to={`/admin/themes/${encodeURIComponent(t.themeName)}`}
                className="font-medium text-indigo-400 hover:text-indigo-300"
              >
                {t.themeName}
              </Link>
              {t.isActive && (
                <span className="rounded bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-300">
                  global default
                </span>
              )}
            </div>
            {t.themeDescription && (
              <p className="mt-1 text-sm text-slate-400">{t.themeDescription}</p>
            )}
            <div className="mt-3 flex gap-3 text-xs">
              {!t.isActive && (
                <button
                  onClick={() => setActiveMutation.mutate(t.themeName)}
                  disabled={setActiveMutation.isPending}
                  className="text-slate-400 hover:text-emerald-400"
                >
                  Set as global default
                </button>
              )}
              {t.themeName !== "default" && !t.isActive && (
                <button
                  onClick={() => {
                    if (window.confirm(`Delete theme "${t.themeName}"? This cannot be undone.`)) {
                      deleteMutation.mutate(t.themeName);
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  className="text-slate-400 hover:text-red-400"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Layout>
  );
}
