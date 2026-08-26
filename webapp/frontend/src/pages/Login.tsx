import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { getMe, LOGIN_URL } from "../api/client";

export default function Login() {
  const { data, isLoading } = useQuery({ queryKey: ["me"], queryFn: getMe });

  if (isLoading) return null;
  if (data) return <Navigate to="/" replace />;

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-slate-950 px-4 text-slate-100">
      <span className="text-4xl" aria-hidden="true">
        🛡️
      </span>
      <h1 className="text-2xl font-semibold">Police Chief Dashboard</h1>
      <p className="mb-3 text-sm text-slate-500">Manage your alliance, right from the browser.</p>
      <a
        href={LOGIN_URL}
        className="flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-500"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.076.076 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028ZM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.955 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
        </svg>
        Sign in with Discord
      </a>
    </div>
  );
}
