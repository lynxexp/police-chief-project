import { Outlet, Navigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getMe } from "../api/client";

/**
 * Gate for every route that needs a logged-in user. Also enforces the
 * Server-tier guild-selection step: if the backend says the caller
 * hasn't picked a guild yet, every protected route except /select-guild
 * bounces there first (see auth/context.ts's needsGuildSelection).
 */
export default function ProtectedRoute() {
  const location = useLocation();
  const { data, isLoading } = useQuery({ queryKey: ["me"], queryFn: getMe });

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-400">
        Loading…
      </div>
    );
  }

  if (!data) {
    return <Navigate to="/login" replace />;
  }

  if (data.needsGuildSelection && location.pathname !== "/select-guild") {
    return <Navigate to="/select-guild" replace />;
  }

  return <Outlet context={data} />;
}

/**
 * Gate for routes that work with or without a login (the Electro Building
 * Calculator and future no-login tools) but should still show the real
 * signed-in chrome (name/tier, sign-out, full nav) to a visitor who
 * happens to already have a session -- rather than always presenting as
 * logged out the way a bare, non-gated route would.
 *
 * Shares ProtectedRoute's ["me"] query key/cache, so a visitor bouncing
 * between a public tool and a protected page doesn't trigger a duplicate
 * /api/auth/me fetch. Never redirects: a 401 here just means ctx is null,
 * same "logged out" shape Layout/Sidebar already handle for routes
 * rendered with no outlet context at all.
 */
export function OptionalAuthRoute() {
  const { data, isLoading } = useQuery({ queryKey: ["me"], queryFn: getMe });

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-400">
        Loading…
      </div>
    );
  }

  return <Outlet context={data} />;
}
