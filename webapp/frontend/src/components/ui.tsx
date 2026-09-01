import { useEffect, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";

/**
 * Shared presentational primitives, restyled for the "Night Watch" design.
 *
 * Every export that existed before keeps its exact name and signature, so
 * this file can be dropped in without touching call sites. The additive
 * exports at the bottom (RankShield, DeltaArrow, StatTile, ProgressTrack,
 * Pill, PageHeader, Portrait) are what the redesign needs everywhere.
 *
 * Colours come from the CSS custom properties in index.css via the @theme
 * mapping, so light mode follows the OS with no work here.
 */

/* ------------------------------------------------------------------ Card */

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-card border border-line bg-surface-panel p-4 ${className}`}
      {...props}
    />
  );
}

/* ----------------------------------------------------------------- Badge */

type BadgeVariant = "success" | "neutral" | "warning" | "danger" | "info";

const BADGE_VARIANT_CLASSES: Record<BadgeVariant, string> = {
  success: "border border-up-fill/40 bg-up-fill/10 text-up-ink",
  neutral: "border border-line-strong bg-surface-sunken text-ink-muted",
  warning: "border border-gold-border bg-gold-tint text-gold-ink",
  danger: "border border-down-border bg-down-tint text-down-ink",
  info: "border border-info-ink/40 bg-info-ink/10 text-info-ink",
};

export function Badge({ variant = "neutral", children }: { variant?: BadgeVariant; children: ReactNode }) {
  return (
    <span
      className={`rounded-pill px-2 py-0.5 font-mono text-[10px] font-bold tracking-pill uppercase ${BADGE_VARIANT_CLASSES[variant]}`}
    >
      {children}
    </span>
  );
}

/* --------------------------------------------------------------- buttons */
// Shared className strings (not components) so both <button> and <Link>
// can reuse identical styling without a polymorphic wrapper component.

export const buttonPrimary =
  "inline-flex items-center justify-center rounded-control bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-4 py-2.5 text-sm font-bold text-on-gold transition-[filter] duration-[var(--motion-fast)] hover:brightness-106 disabled:opacity-50";
export const buttonSecondary =
  "inline-flex items-center justify-center rounded-control border border-line-strong px-4 py-2.5 text-sm text-ink-secondary transition-colors duration-[var(--motion-fast)] hover:border-line-strong hover:bg-white/[.03] disabled:opacity-50";
export const buttonDanger =
  "inline-flex items-center justify-center rounded-control border border-down-border px-4 py-2.5 text-sm text-down-ink transition-colors duration-[var(--motion-fast)] hover:bg-down-tint disabled:opacity-50";

/* -------------------------------------------------------- text furniture */

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 font-display text-[19px] font-semibold tracking-heading text-ink uppercase">
      {children}
    </h2>
  );
}

/** Mono uppercase label that sits above a title or figure. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[11px] tracking-eyebrow text-ink-faint uppercase">{children}</p>
  );
}

/** Standard page header: eyebrow + condensed title + optional actions. */
export function PageHeader({
  eyebrow,
  title,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-1.5">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <h1 className="font-display text-[34px] leading-none font-bold tracking-title text-ink uppercase lg:text-[40px]">
          {title}
        </h1>
      </div>
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2.5">{actions}</div> : null}
    </header>
  );
}

/* ------------------------------------------------------- loading / empty */

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="space-y-2" role="status" aria-label={label}>
      <div className="pulse-skel h-4 w-2/3 rounded-pill bg-surface-sunken" />
      <div className="pulse-skel h-4 w-1/2 rounded-pill bg-surface-sunken" />
      <div className="pulse-skel h-4 w-5/6 rounded-pill bg-surface-sunken" />
    </div>
  );
}

/** Table skeleton at the real row height, so the page never jumps. */
export function LoadingRows({ rows = 5, label = "Loading…" }: { rows?: number; label?: string }) {
  return (
    <div className="overflow-hidden rounded-card border border-line" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-[46px] items-center gap-3 border-t border-line-hairline px-4 first:border-t-0">
          <div className="pulse-skel h-3.5 w-8 rounded-pill bg-surface-sunken" />
          <div className="pulse-skel h-3.5 flex-1 rounded-pill bg-surface-sunken" />
          <div className="pulse-skel h-3.5 w-20 rounded-pill bg-surface-sunken" />
        </div>
      ))}
    </div>
  );
}

/**
 * Errors get a panel, not a bare sentence: what failed, the likely cause,
 * the raw request line, and a retry with an attempt counter. Pass
 * react-query's refetch as onRetry.
 */
export function ErrorState({
  message,
  headline = "Something didn't load",
  requestLine,
  attempt = 0,
  onRetry,
}: {
  message: string;
  headline?: string;
  requestLine?: string;
  attempt?: number;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-down-border bg-surface-panel p-4">
      <div className="flex items-center gap-3">
        <Shield size={46} tone="danger">×</Shield>
        <h2 className="font-display text-2xl leading-tight font-bold text-ink uppercase">{headline}</h2>
      </div>
      <p className="text-sm leading-relaxed text-ink-secondary">{message}</p>
      {requestLine ? (
        <code className="rounded-control bg-surface-sunken px-3 py-2 font-mono text-[11px] text-down-ink">
          {requestLine}
        </code>
      ) : null}
      {onRetry ? (
        <div className="flex items-center gap-3">
          <button type="button" className={buttonSecondary} onClick={onRetry}>
            Retry
          </button>
          {attempt > 0 ? (
            <span className="font-mono text-[11px] text-ink-faint">
              ATTEMPT {attempt + 1}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Empty states always name their next action. */
export function EmptyState({
  children,
  action,
}: {
  /** @deprecated the emoji icon is gone — an outline shield is drawn instead */
  icon?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line-strong px-4 py-8 text-center">
      <Shield size={40} tone="outline" />
      <p className="text-sm text-ink-muted">{children}</p>
      {action}
    </div>
  );
}

/* ---------------------------------------------------------------- shield */

const SHIELD_CLIP = "polygon(50% 0, 100% 18%, 100% 62%, 50% 100%, 0 62%, 0 18%)";

type ShieldTone = "gold" | "silver" | "bronze" | "success" | "danger" | "outline";

const SHIELD_FILL: Record<ShieldTone, string> = {
  gold: "linear-gradient(160deg, var(--gold-fill-from), var(--gold-fill-to))",
  silver: "var(--shield-silver)",
  bronze: "var(--shield-bronze)",
  success: "linear-gradient(160deg, var(--up-fill), color-mix(in oklch, var(--up-fill) 70%, black))",
  danger: "linear-gradient(160deg, var(--down-fill), color-mix(in oklch, var(--down-fill) 70%, black))",
  outline: "transparent",
};

/** The rank shield is not an icon — it is this clip-path, filled. */
export function Shield({
  size = 44,
  tone = "gold",
  children,
  pop = false,
}: {
  size?: number;
  tone?: ShieldTone;
  children?: ReactNode;
  pop?: boolean;
}) {
  const outline = tone === "outline";
  // The outline variant is drawn as an SVG stroke, never as border + clip-path:
  // clip-path clips the border box to the polygon, so a bordered shield loses
  // every diagonal edge and renders as two vertical slivers.
  return (
    <span
      aria-hidden={!children}
      className={`relative grid flex-none place-items-center font-display font-bold ${pop ? "shield-pop" : ""} ${
        outline ? "text-ink-faint" : ""
      }`}
      style={{
        width: size,
        height: Math.round(size * 1.15),
        clipPath: outline ? undefined : SHIELD_CLIP,
        background: outline ? undefined : SHIELD_FILL[tone],
        color: outline ? undefined : tone === "bronze" ? "#1c1109" : "var(--on-gold)",
        fontSize: Math.round(size * 0.32),
      }}
    >
      {outline ? (
        <svg
          viewBox="0 0 100 116"
          preserveAspectRatio="none"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <polygon
            points="50,3 97,20.9 97,71.9 50,113 3,71.9 3,20.9"
            fill="none"
            stroke="currentColor"
            strokeWidth={4}
          />
        </svg>
      ) : null}
      {children ? <span className="relative">{children}</span> : null}
    </span>
  );
}

/** Ranks 1–3 get metal; 4+ get a zero-padded mono numeral. */
export function RankShield({ rank, pop = false, size = 44 }: { rank: number; pop?: boolean; size?: number }) {
  if (rank > 3) {
    return (
      <span className="font-mono text-sm text-ink-muted tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>
    );
  }
  const tone: ShieldTone = rank === 1 ? "gold" : rank === 2 ? "silver" : "bronze";
  return (
    <Shield size={size} tone={tone} pop={pop}>
      {rank}
    </Shield>
  );
}

/* ------------------------------------------------------------- data bits */

/** ▲ / ▼ / – with the matching ink. Pass a rounded percentage. */
export function DeltaArrow({ pct, className = "" }: { pct: number | null; className?: string }) {
  if (pct === null || Number.isNaN(pct)) {
    return <span className={`text-sm text-ink-faint ${className}`}>–</span>;
  }
  const flat = Math.round(pct) === 0;
  if (flat) return <span className={`text-sm font-semibold text-ink-faint ${className}`}>– 0%</span>;
  const up = pct > 0;
  return (
    <span className={`text-sm font-semibold ${up ? "text-up-ink" : "text-down-ink"} ${className}`}>
      {up ? "▲" : "▼"} {Math.abs(Math.round(pct))}%
    </span>
  );
}

/** KPI tile. `inverted` is the navy/gold variant — use it on one tile per
 *  strip so four tiles don't read as four identical boxes. */
export function StatTile({
  label,
  figure,
  denominator,
  delta,
  inverted = false,
}: {
  label: ReactNode;
  figure: ReactNode;
  denominator?: ReactNode;
  delta?: ReactNode;
  inverted?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-card border p-4 ${
        inverted
          ? "border-rail-border bg-gradient-to-br from-rail-top to-rail-bottom"
          : "border-line bg-surface-panel"
      }`}
    >
      <p className="font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">{label}</p>
      <p
        className={`font-display text-[32px] leading-none font-bold tabular-nums ${
          inverted ? "text-gold-ink" : "text-ink"
        }`}
      >
        {figure}
        {denominator ? <span className="text-[19px] text-ink-muted">/{denominator}</span> : null}
      </p>
      {delta}
    </div>
  );
}

/** Progress track. Gold by default; pass tone for the streak panel. */
export function ProgressTrack({
  pct,
  tone = "gold",
  height = 14,
}: {
  pct: number;
  tone?: "gold" | "up" | "down";
  height?: number;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const fill =
    tone === "gold"
      ? "linear-gradient(90deg, #8a6f18, var(--gold-fill-from))"
      : tone === "up"
        ? "var(--up-fill)"
        : "var(--down-fill)";
  return (
    <div
      className="overflow-hidden rounded-pill border border-line bg-surface-sunken"
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-pill transition-[width] duration-[var(--motion-base)]"
        style={{
          width: `${clamped}%`,
          background: fill,
          boxShadow: tone === "gold" ? "0 0 18px rgba(234,207,98,.4)" : undefined,
        }}
      />
    </div>
  );
}

/** 42x24 track / 18px knob switch. Real button[role=switch], not a
 * checkbox skin -- the track is decorative, the button is the hit area. */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-6 w-[42px] shrink-0 rounded-pill transition-colors duration-[var(--motion-fast)] disabled:opacity-50 max-sm:h-[26px] max-sm:w-[46px]"
      style={{ background: checked ? "var(--gold-fill-to)" : "var(--border)" }}
    >
      <span
        className="absolute top-[3px] h-[18px] w-[18px] rounded-full transition-[left] duration-[var(--motion-fast)] max-sm:h-5 max-sm:w-5"
        style={{ left: checked ? "calc(100% - 21px)" : "3px", background: checked ? "#14202B" : "var(--text-faint)" }}
      />
    </button>
  );
}

/** Mono pill used for trap tabs and filters. */
export function Pill({
  active = false,
  children,
  ...props
}: { active?: boolean; children: ReactNode } & HTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`rounded-pill px-3 py-2 font-mono text-[11px] tracking-pill uppercase transition-colors duration-[var(--motion-fast)] ${
        active
          ? "border border-gold-border bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] font-bold text-on-gold"
          : "border border-line-strong text-ink-muted hover:text-ink-secondary"
      }`}
      aria-pressed={active}
      {...props}
    >
      {children}
    </button>
  );
}

/** Click-to-edit number cell: local draft state so typing doesn't fight a
 * server round-trip, committed onBlur only when the value actually
 * changed. Used anywhere an admin table has a raw numeric field that's
 * cheaper to edit inline than through a modal (member Chief's Office
 * level/power, vault hunt damage/rank). */
export function EditableNumberCell({
  value,
  onSave,
  min,
  max,
  disabled,
}: {
  value: number | null;
  onSave: (v: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value !== null ? String(value) : "");
  useEffect(() => {
    setDraft(value !== null ? String(value) : "");
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(value !== null ? String(value) : "");
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n === value) return;
    onSave(n);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="w-20 rounded-control border border-line bg-surface-sunken px-2 py-1 font-mono text-ink-secondary focus:border-gold-border disabled:opacity-50"
    />
  );
}

/** One attendance session. `streak-break` is a third colour on purpose —
 *  green-vs-grey alone was too weak in light mode. */
export function AttendanceBlock({ state }: { state: "attended" | "missed" | "streak-break" }) {
  const bg =
    state === "attended" ? "var(--up-fill)" : state === "missed" ? "var(--miss)" : "var(--down-fill)";
  return (
    <span
      className="h-[22px] flex-1 rounded-block max-md:h-2 max-md:w-3.5 max-md:flex-none"
      style={{ background: bg }}
      title={state.replace("-", " ")}
    />
  );
}

/* ------------------------------------------------------------- portrait ---
   Decided during design review: ship the striped placeholder. No player art
   exists yet, and generic silhouettes read worse than an honest empty slot.
   Every portrait in the product goes through here, so the day the game
   exposes an avatar URL it is a data change and not a layout change — pass
   `src`, keep the sizes.
   ------------------------------------------------------------------------ */

const PORTRAIT_SIZES = {
  record: { w: 92, h: 108, caption: 10 },   // member detail header
  card:   { w: 76, h: 92,  caption: 9.5 },  // character / member card
  row:    { w: 44, h: 52,  caption: 0 },    // mobile list row
} as const;

export function Portrait({
  size = "card",
  src,
  alt,
  caption = "NO PORTRAIT",
}: {
  size?: keyof typeof PORTRAIT_SIZES;
  src?: string | null;
  alt: string;
  caption?: string;
}) {
  const [failed, setFailed] = useState(false);
  const { w, h, caption: captionSize } = PORTRAIT_SIZES[size];
  const showImage = Boolean(src) && !failed;

  return (
    <div
      className="flex-none overflow-hidden rounded-block border border-line-strong"
      style={{
        width: w,
        height: h,
        background: showImage
          ? "var(--surface-sunken)"
          : "repeating-linear-gradient(135deg, var(--portrait-stripe-a) 0 6px, var(--portrait-stripe-b) 6px 12px)",
      }}
    >
      {showImage ? (
        <img
          src={src as string}
          alt={alt}
          width={w}
          height={h}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          role="img"
          aria-label={alt}
          className="grid h-full w-full place-items-center px-1 text-center font-mono uppercase leading-tight tracking-eyebrow text-ink-faint"
          style={{ fontSize: captionSize || undefined, visibility: captionSize ? undefined : "hidden" }}
        >
          {caption}
        </span>
      )}
    </div>
  );
}
