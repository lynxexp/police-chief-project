import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { logout, LOGIN_URL, type AuthContext } from "../api/client";
import { SidebarContent } from "./Sidebar";

const TIER_LABELS: Record<AuthContext["tier"], string> = {
  owner: "Owner",
  global: "Global admin",
  server: "Server admin",
  alliance: "Alliance admin",
  none: "Member",
};

/** Shared chrome for every page past the auth gate: a persistent sidebar
 * (desktop) / slide-over drawer (mobile) built from route context + tier,
 * plus a consistent page header. Every page under ProtectedRoute renders
 * inside its Outlet, so useOutletContext resolves here even though Layout
 * itself isn't the route element -- and since this is rendered as a
 * descendant of the matched route, useLocation/useParams inside
 * SidebarContent see the same route params the page itself does, with no
 * per-page wiring needed.
 *
 * A handful of routes (the Building Calculator) render Layout OUTSIDE
 * ProtectedRoute's Outlet on purpose -- they need no login at all, so
 * useOutletContext resolves to undefined there rather than a real
 * AuthContext. Normalized to null below so every ctx check in this file
 * and in Sidebar.tsx is one falsy check, not two different "no auth"
 * representations to remember. */
export default function Layout({
  title,
  backTo,
  actions,
  children,
}: {
  title: string;
  backTo?: { to: string; label: string };
  /** Optional page-level action button(s), rendered top-right of the header. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const ctx = useOutletContext<AuthContext | undefined>() ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.setQueryData(["me"], null);
      navigate("/login", { replace: true });
    },
  });

  const sidebarFooter = ctx ? (
    <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-3 py-3">
      <span className="truncate text-xs text-slate-500">{TIER_LABELS[ctx.tier]}</span>
      <button
        onClick={() => logoutMutation.mutate()}
        disabled={logoutMutation.isPending}
        className="shrink-0 rounded-md border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
      >
        Sign out
      </button>
    </div>
  ) : (
    <div className="border-t border-slate-800 px-3 py-3">
      <a
        href={LOGIN_URL}
        className="block rounded-md bg-indigo-600 px-2.5 py-1.5 text-center text-xs font-medium text-white hover:bg-indigo-500"
      >
        Sign in with Discord
      </a>
    </div>
  );

  const homeLink = ctx ? "/" : "/electro-building-calculator";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Mobile top bar */}
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900/60 px-4 py-3 lg:hidden">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          className="rounded-md border border-slate-700 p-1.5 hover:bg-slate-800"
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <Link to={homeLink} className="font-semibold hover:text-indigo-400">
          Police Chief
        </Link>
        <span className="text-xs text-slate-500">{ctx ? TIER_LABELS[ctx.tier] : "Guest"}</span>
      </header>

      <div className="mx-auto flex max-w-[88rem]">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900/40 lg:flex">
          <Link to={homeLink} className="flex items-center gap-2 px-4 py-4 font-semibold hover:text-indigo-400">
            <span aria-hidden="true">🛡️</span> Police Chief
          </Link>
          <div className="min-h-0 flex-1">
            <SidebarContent ctx={ctx} onNavigate={() => {}} />
          </div>
          {sidebarFooter}
        </aside>

        {/* Mobile drawer */}
        {drawerOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-slate-950 shadow-xl">
              <div className="flex items-center justify-between px-4 py-4">
                <Link to={homeLink} className="font-semibold hover:text-indigo-400">
                  🛡️ Police Chief
                </Link>
                <button
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close navigation"
                  className="rounded-md border border-slate-700 p-1.5 hover:bg-slate-800"
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <SidebarContent ctx={ctx} onNavigate={() => setDrawerOpen(false)} />
              </div>
              {sidebarFooter}
            </aside>
          </div>
        )}

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8">
          <div className="mx-auto max-w-5xl">
            {backTo && (
              <Link
                to={backTo.to}
                className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-300"
              >
                ← {backTo.label}
              </Link>
            )}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-xl font-semibold">{title}</h1>
              {actions && <div className="flex items-center gap-2">{actions}</div>}
            </div>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
