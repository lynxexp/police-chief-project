import type { HTMLAttributes, ReactNode } from "react";

/**
 * Small shared primitives factoring out patterns that were copy-pasted
 * across every page (card containers, status badges, button styling,
 * section headings, loading/empty states). Purely presentational --
 * intentionally has no data-fetching or routing awareness, so it's safe
 * to use from any page without new dependencies.
 */

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-slate-800 bg-slate-900 p-4 ${className}`}
      {...props}
    />
  );
}

type BadgeVariant = "success" | "neutral" | "warning" | "danger" | "info";

const BADGE_VARIANT_CLASSES: Record<BadgeVariant, string> = {
  success: "bg-emerald-950 text-emerald-400",
  neutral: "bg-slate-800 text-slate-400",
  warning: "bg-amber-950/60 text-amber-300",
  danger: "bg-red-950/60 text-red-300",
  info: "bg-indigo-950/60 text-indigo-300",
};

export function Badge({ variant = "neutral", children }: { variant?: BadgeVariant; children: ReactNode }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${BADGE_VARIANT_CLASSES[variant]}`}>{children}</span>
  );
}

// Shared className strings (not components) so both <button> and <Link>
// can reuse identical styling without a polymorphic wrapper component.
export const buttonPrimary =
  "inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
export const buttonSecondary =
  "inline-flex items-center justify-center rounded-md border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-50";
export const buttonDanger =
  "inline-flex items-center justify-center rounded-md border border-red-900 px-4 py-2 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50";

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-sm font-medium text-slate-300">{children}</h2>;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="space-y-2" role="status" aria-label={label}>
      <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-slate-800" />
      <div className="h-4 w-5/6 animate-pulse rounded bg-slate-800" />
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return <p className="text-sm text-red-400">{message}</p>;
}

export function EmptyState({ icon = "🗂️", children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center">
      <div className="mb-2 text-2xl" aria-hidden="true">
        {icon}
      </div>
      <p className="text-sm text-slate-500">{children}</p>
    </div>
  );
}
