import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserRound, Trophy, CalendarDays, Gift, LogOut } from "lucide-react";
import { logout, LOGIN_URL, getMyDisplayName, type AuthContext } from "../api/client";
import { SidebarContent } from "./Sidebar";
import { Shield, PageHeader } from "./ui";
import { useThemePreference, type ThemeMode } from "../hooks/theme";

const TIER_LABELS: Record<AuthContext["tier"], string> = {
  owner: "Owner",
  global: "Global admin",
  server: "Server admin",
  alliance: "Alliance admin",
  none: "Member",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const chars = parts.length > 1 ? [parts[0][0], parts[parts.length - 1][0]] : [name.slice(0, 2)];
  return chars.join("").toUpperCase();
}

/** Live clock for the mobile header's status row -- plain text on a 1s
 * interval, never animated per digit (see Motion Spec: "Countdowns are
 * plain text... never animated per digit"). */
function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Dark/Light pick, shown on the rail regardless of login state -- colour
 * mode is a device preference, not an account setting. Sits just above
 * the user/sign-in card, matching the reference layout. */
function ThemeToggle() {
  const { theme, setTheme } = useThemePreference();
  const options: { mode: ThemeMode; label: string }[] = [
    { mode: "dark", label: "Dark" },
    { mode: "light", label: "Light" },
  ];
  return (
    <div role="group" aria-label="Colour theme" className="flex gap-1 rounded-pill border border-rail-border bg-black/20 p-1">
      {options.map((o) => (
        <button
          key={o.mode}
          type="button"
          aria-pressed={theme === o.mode}
          onClick={() => setTheme(o.mode)}
          className={`flex-1 rounded-pill py-1.5 font-mono text-[11px] tracking-pill uppercase transition-colors duration-[var(--motion-fast)] ${
            theme === o.mode
              ? "bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] font-bold text-on-gold"
              : "text-rail-text hover:text-ink-secondary"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const BOTTOM_TABS = [
  { key: "profile", to: "/", label: "Profile", icon: UserRound, exact: true },
  { key: "ranks", label: "Ranks", icon: Trophy },
  { key: "events", label: "Events", icon: CalendarDays },
  { key: "codes", to: "/gift-codes", label: "Codes", icon: Gift, exact: true },
] as const;

/** Shared chrome for every page past the auth gate: a persistent navy
 * rail (desktop) / slide-over drawer (mobile) built from route context +
 * tier, plus a consistent page header. Every page under ProtectedRoute
 * renders inside its Outlet, so useOutletContext resolves here even
 * though Layout itself isn't the route element -- and since this is
 * rendered as a descendant of the matched route, useLocation/useParams
 * inside SidebarContent see the same route params the page itself does,
 * with no per-page wiring needed.
 *
 * A handful of routes (the Electro Building Calculator) render Layout
 * OUTSIDE ProtectedRoute's Outlet on purpose -- they need no login at
 * all, so useOutletContext resolves to undefined there rather than a
 * real AuthContext. Normalized to null below so every ctx check in this
 * file and in Sidebar.tsx is one falsy check, not two different "no
 * auth" representations to remember. */
export default function Layout({
  title,
  eyebrow,
  backTo,
  actions,
  hideHeader = false,
  children,
}: {
  title: string;
  /** Mono uppercase context line above the title (e.g. "SIGNED IN AS ..."). */
  eyebrow?: ReactNode;
  backTo?: { to: string; label: string };
  /** Optional page-level action button(s), rendered top-right of the header. */
  actions?: ReactNode;
  /** Skip Layout's own PageHeader -- for pages that build their own
   * custom hero-style header (e.g. AllianceOverview's gradient panel).
   * `title` is still required and still used for the mobile header line
   * and the browser tab, just not rendered a second time on desktop. */
  hideHeader?: boolean;
  children: ReactNode;
}) {
  const ctx = useOutletContext<AuthContext | undefined>() ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const { allianceId } = useParams<{ allianceId?: string }>();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const clock = useClock();

  const drawerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Focus trap: move focus into the drawer on open, keep Tab cycling
  // within it, restore focus to the menu button on close, Escape closes.
  useEffect(() => {
    if (!drawerOpen) return;
    const panel = drawerRef.current;
    const focusables = panel?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
    );
    focusables?.[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (e.key !== "Tab" || !focusables?.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      menuButtonRef.current?.focus();
    };
  }, [drawerOpen]);

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.setQueryData(["me"], null);
      navigate("/login", { replace: true });
    },
  });

  // Fetched once per session, not on every /auth/me poll -- see
  // getMyDisplayName's doc comment for why it's a separate call.
  const { data: profile } = useQuery({
    queryKey: ["me", "displayName"],
    queryFn: getMyDisplayName,
    enabled: Boolean(ctx),
    staleTime: 10 * 60 * 1000,
  });
  const displayName = profile?.displayName ?? null;

  const sidebarFooter = ctx ? (
    <div className="flex items-center gap-2.5 border-t border-rail-border px-1 pt-3">
      <div className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-control bg-white/[.06] font-display text-sm font-bold text-gold-ink">
        {initials(displayName ?? ctx.discordId)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-sans text-[13px] text-ink-secondary">{displayName ?? "Signed in"}</p>
        <p className="font-mono text-[10px] tracking-pill text-gold-ink uppercase">{TIER_LABELS[ctx.tier]}</p>
      </div>
      <button
        onClick={() => logoutMutation.mutate()}
        disabled={logoutMutation.isPending}
        aria-label="Sign out"
        className="shrink-0 rounded-control p-1.5 text-rail-text hover:bg-white/[.04] hover:text-ink-secondary disabled:opacity-50"
      >
        <LogOut size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  ) : (
    <div className="border-t border-rail-border pt-3">
      <a href={LOGIN_URL} className={PRIMARY_FOOTER_BUTTON}>
        Sign in with Discord
      </a>
    </div>
  );

  const homeLink = ctx ? "/" : "/electro-building-calculator";

  // Bottom tab bar (member screens only, mobile): Ranks/Events need an
  // alliance in scope to resolve to a real leaderboard/calendar. Outside
  // an alliance route (e.g. the profile page itself) they fall back to
  // "/" rather than a dead link -- there's no global "your alliance" to
  // resolve to without an extra query this shell doesn't otherwise need.
  const showBottomTabs = Boolean(ctx) && !location.pathname.startsWith("/admin");
  const bottomTabHref = (tab: (typeof BOTTOM_TABS)[number]): string => {
    if ("to" in tab) return tab.to;
    if (!allianceId) return "/";
    return tab.key === "ranks" ? `/alliance/${allianceId}/leaderboard/vault` : `/alliance/${allianceId}/calendar`;
  };

  return (
    <div className="min-h-screen bg-surface-page text-ink">
      {/* Mobile header block */}
      <header
        className="lg:hidden"
        style={{ background: "linear-gradient(180deg, var(--rail-top), var(--rail-bottom))", padding: "12px 20px 16px" }}
      >
        <div className="flex items-center justify-between">
          <button
            ref={menuButtonRef}
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="rounded-control border border-rail-border p-1.5 text-rail-text hover:bg-white/[.04]"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <div className="flex items-center gap-2 font-mono text-[11px] tracking-pill text-rail-text uppercase">
            <span aria-hidden="true">{clock}</span>
            <span className="text-rail-label">·</span>
            <span>{ctx ? TIER_LABELS[ctx.tier] : "Guest"}</span>
          </div>
        </div>
        {/* The mobile header stays navy in both colour modes (same as the
            rail -- see its own comment), so its title needs a fixed light
            colour here, not text-ink, which would go near-black in light
            mode and disappear against this background. */}
        <h1 className="mt-2 font-display text-[26px] leading-none font-bold text-[#E6EAEF]">{title}</h1>
      </header>

      <div className="mx-auto flex max-w-[88rem]">
        {/* Desktop navy rail */}
        <aside
          className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r border-rail-border lg:flex"
          style={{ background: "linear-gradient(180deg, var(--rail-top), var(--rail-bottom))", padding: "20px 14px", gap: 22 }}
        >
          <Link to={homeLink} className="flex items-center gap-2.5 px-1">
            <Shield size={32} tone="gold">
              PC
            </Shield>
            <span className="font-display text-[18px] font-semibold tracking-[.1em] text-[#E6EAEF] uppercase">
              Police Chief
            </span>
          </Link>
          <div className="min-h-0 flex-1">
            <SidebarContent ctx={ctx} onNavigate={() => {}} />
          </div>
          <ThemeToggle />
          {sidebarFooter}
        </aside>

        {/* Mobile drawer */}
        {drawerOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div
              className="absolute inset-0 bg-[rgba(4,7,10,.68)]"
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <aside
              ref={drawerRef}
              className="drawer absolute inset-y-0 left-0 flex w-[286px] flex-col border-r border-rail-border"
              style={{ background: "linear-gradient(180deg, var(--rail-top), var(--rail-bottom))", padding: "20px 14px", gap: 22 }}
            >
              <div className="flex items-center justify-between px-1">
                <Link to={homeLink} className="flex items-center gap-2.5">
                  <Shield size={32} tone="gold">
                    PC
                  </Shield>
                  <span className="font-display text-[18px] font-semibold tracking-[.1em] text-[#E6EAEF] uppercase">
                    Police Chief
                  </span>
                </Link>
                <button
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close navigation"
                  className="rounded-control border border-rail-border p-1.5 text-rail-text hover:bg-white/[.04]"
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <SidebarContent ctx={ctx} onNavigate={() => setDrawerOpen(false)} />
              </div>
              <ThemeToggle />
              {sidebarFooter}
            </aside>
          </div>
        )}

        <main
          className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8 lg:px-[30px] lg:py-[26px]"
          style={{ paddingBottom: showBottomTabs ? 88 : undefined }}
        >
          <div className="route-content mx-auto flex max-w-5xl flex-col gap-5">
            {backTo && (
              <Link
                to={backTo.to}
                className="inline-flex items-center gap-1 self-start font-sans text-sm text-ink-muted hover:text-ink-secondary"
              >
                ← {backTo.label}
              </Link>
            )}
            {!hideHeader && (
              <div className="hidden lg:block">
                <PageHeader eyebrow={eyebrow} title={title} actions={actions} />
              </div>
            )}
            {actions && <div className="flex items-center gap-2.5 lg:hidden">{actions}</div>}
            {children}
          </div>
        </main>
      </div>

      {/* Bottom tab bar -- member screens only, replaces reaching for the
          drawer for the four most-visited destinations. */}
      {showBottomTabs && (
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-line bg-surface-header lg:hidden"
          style={{ padding: "10px 8px 20px" }}
        >
          {BOTTOM_TABS.map((tab) => {
            const href = bottomTabHref(tab);
            const active =
              "to" in tab
                ? tab.exact
                  ? location.pathname === tab.to
                  : location.pathname.startsWith(tab.to)
                : href !== "/" && location.pathname.startsWith(href.replace(/\/(leaderboard|calendar).*$/, ""));
            const Icon = tab.icon;
            return (
              <Link
                key={tab.key}
                to={href}
                aria-current={active ? "page" : undefined}
                className="flex min-h-[48px] flex-col items-center justify-center gap-0.5"
              >
                {active ? (
                  <Shield size={20} tone="gold">
                    {""}
                  </Shield>
                ) : (
                  <Icon size={20} strokeWidth={1.75} className="text-rail-text" aria-hidden="true" />
                )}
                <span className={`font-sans text-[11px] ${active ? "font-semibold text-gold-ink" : "text-rail-text"}`}>
                  {tab.label}
                </span>
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}

const PRIMARY_FOOTER_BUTTON =
  "block rounded-control bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-2.5 py-2 text-center font-sans text-xs font-bold text-on-gold hover:brightness-106";
