import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { getThemes, createTheme, deleteTheme, setActiveTheme } from "../api/client";
import { Badge, Card, ErrorState, LoadingRows, SectionHeading, buttonPrimary } from "../components/ui";

export default function AdminThemes() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
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
  const deleteMutation = useMutation({ mutationFn: (name: string) => deleteTheme(name), onSuccess: invalidate });
  const setActiveMutation = useMutation({ mutationFn: (name: string) => setActiveTheme(name), onSuccess: invalidate });

  return (
    <Layout title="Themes" backTo={{ to: "/admin", label: "Admin" }}>
      <Card>
        <SectionHeading>Create a new theme</SectionHeading>
        <div className="flex flex-wrap gap-2">
          <input
            placeholder="New theme name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="rounded-control border border-line bg-surface-sunken px-3 py-2 text-sm text-ink"
          />
          <button onClick={() => createMutation.mutate()} disabled={!newName.trim() || createMutation.isPending} className={buttonPrimary}>
            Create (clones "default")
          </button>
        </div>
        {createMutation.isError && <p className="mt-2 text-sm text-down-ink">{(createMutation.error as Error).message}</p>}
      </Card>

      {isLoading && <LoadingRows rows={3} />}
      {error && <ErrorState message="Couldn't load themes." onRetry={refetch} />}

      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((t) => (
          <Card key={t.themeName}>
            <div className="flex items-center justify-between">
              <Link to={`/admin/themes/${encodeURIComponent(t.themeName)}`} className="font-display text-lg font-semibold text-gold-ink hover:text-text">
                {t.themeName}
              </Link>
              {t.isActive && <Badge variant="success">global default</Badge>}
            </div>
            {t.themeDescription && <p className="mt-1 text-sm text-ink-muted">{t.themeDescription}</p>}
            <div className="mt-3 flex gap-3 text-xs">
              {!t.isActive && (
                <button onClick={() => setActiveMutation.mutate(t.themeName)} disabled={setActiveMutation.isPending} className="text-ink-muted hover:text-up-ink">
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
                  className="text-ink-muted hover:text-down-ink"
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
