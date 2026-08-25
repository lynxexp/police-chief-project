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
