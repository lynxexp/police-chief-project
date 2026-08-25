import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { getMe, LOGIN_URL } from "../api/client";

export default function Login() {
  const { data, isLoading } = useQuery({ queryKey: ["me"], queryFn: getMe });

  if (isLoading) return null;
  if (data) return <Navigate to="/" replace />;

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-slate-950 text-slate-100">
      <h1 className="text-2xl font-semibold">Police Chief Dashboard</h1>
      <a
        href={LOGIN_URL}
        className="rounded-md bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-500"
      >
        Sign in with Discord
      </a>
    </div>
  );
}
