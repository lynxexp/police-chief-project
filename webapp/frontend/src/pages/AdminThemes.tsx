import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { getThemes, createTheme, deleteTheme, setActiveTheme } from "../api/client";
import { Badge, Card, ErrorState, LoadingState, SectionHeading } from "../components/ui";

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
      <Card className="mb-6">
        <SectionHeading>Create a new theme</SectionHeading>
        <div className="flex gap-2">
          <input
            placeholder="New theme name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
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
          <p className="mt-2 text-sm text-red-400">{(createMutation.error as Error).message}</p>
        )}
      </Card>

      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load themes." />}

      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((t) => (
          <Card key={t.themeName}>
            <div className="flex items-center justify-between">
              <Link
                to={`/admin/themes/${encodeURIComponent(t.themeName)}`}
                className="font-medium text-indigo-400 hover:text-indigo-300"
              >
                {t.themeName}
              </Link>
              {t.isActive && <Badge variant="success">global default</Badge>}
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
          </Card>
        ))}
      </div>
    </Layout>
  );
}
