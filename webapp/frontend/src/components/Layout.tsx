import type { ReactNode } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { logout, type AuthContext } from "../api/client";

/** Shared chrome for every page past the auth gate -- title bar with a
 * Home link, caller identity, and sign-out. Every page under
 * ProtectedRoute renders inside its Outlet, so useOutletContext resolves
 * here even though Layout itself isn't the route element. */
export default function Layout({
  title,
  backTo,
  children,
}: {
  title: string;
  backTo?: { to: string; label: string };
  children: ReactNode;
}) {
  const ctx = useOutletContext<AuthContext>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.setQueryData(["me"], null);
      navigate("/login", { replace: true });
    },
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/60">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link to="/" className="font-semibold hover:text-indigo-400">
              Police Chief
            </Link>
            <Link to="/gift-codes" className="text-sm text-slate-400 hover:text-slate-200">
              Gift codes
            </Link>
            {ctx.tier !== "none" && (
              <Link to="/admin" className="text-sm text-slate-400 hover:text-slate-200">
                Admin
              </Link>
            )}
            {backTo && (
              <Link to={backTo.to} className="text-sm text-slate-400 hover:text-slate-200">
                ← {backTo.label}
              </Link>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm text-slate-400">
            <span className="capitalize">{ctx.tier} tier</span>
            <button
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="mb-6 text-xl font-semibold">{title}</h1>
        {children}
      </main>
    </div>
  );
}
