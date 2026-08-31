import { Link, useLocation, useParams } from "react-router-dom";
import type { ComponentType } from "react";
import {
  UserRound,
  Gift,
  Gauge,
  Trophy,
  CalendarCheck,
  CalendarDays,
  UsersRound,
  Flag,
  Hash,
  Bell,
  Palette,
  KeyRound,
  ScrollText,
  Activity,
  DatabaseBackup,
  ClipboardList,
  Calculator,
} from "lucide-react";
import type { AuthContext } from "../api/client";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** Defaults to prefix-match; set exact for items whose path is a
   * prefix of another item's (e.g. "/" vs "/alliance/1"). */
  exact?: boolean;
  /** Unread-count style trailing pill (e.g. gift codes). Left unwired for
   * now -- no cheap existing data source without a dedicated query, and
   * the ground rule here is never invent a number. The slot exists so
   * wiring one later is additive, not a restructure. */
  badge?: number;
}

interface NavSection {
  heading?: string;
  items: NavItem[];
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-control px-2.5 py-2.5 font-sans text-sm transition-colors duration-[var(--motion-fast)] ${
        active
          ? "border-l-[3px] border-[#C9A227] bg-[rgba(201,162,39,.14)] font-semibold text-gold-ink"
          : "border-l-[3px] border-transparent text-rail-text hover:bg-white/[.04] hover:text-ink-secondary"
      }`}
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.badge ? (
        <span className="shrink-0 rounded-pill bg-down-fill px-1.5 py-0.5 font-mono text-[11px] font-bold text-white">
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-1.5 px-2 font-mono text-[10px] tracking-eyebrow text-rail-label uppercase">{children}</div>
  );
}

/** Tools that need no login at all -- pure static game data/calculators,
 * nothing alliance-specific for a login to protect. Shown to logged-out
 * visitors (including on /login itself) AND folded into the logged-in
 * sidebar's top section below, so this list is the one place to add the
 * next one rather than two. */
const PUBLIC_TOOLS: NavItem[] = [
  { to: "/electro-building-calculator", label: "Electro Building Calculator", icon: Calculator },
];

/** Sidebar nav content, shared by the desktop rail and the mobile drawer.
 * Builds its own section list from route params + auth tier rather than
 * being handed props, so every page gets full navigation for free just by
 * rendering <Layout> -- no per-page wiring. */
export function SidebarContent({ ctx, onNavigate }: { ctx: AuthContext | null; onNavigate: () => void }) {
  const location = useLocation();
  const { allianceId } = useParams<{ allianceId?: string }>();

  if (!ctx) {
    return (
      <nav className="flex h-full flex-col gap-5 overflow-y-auto px-3 py-4">
        <div>
          <SectionLabel>Free tools</SectionLabel>
          <div className="flex flex-col gap-[3px]">
            {PUBLIC_TOOLS.map((item) => (
              <NavLink key={item.to} item={item} active={isActive(location.pathname, item)} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      </nav>
    );
  }

  const isAdmin = ctx.tier !== "none";

  const sections: NavSection[] = [
    {
      items: [
        { to: "/", label: "Your profile", icon: UserRound, exact: true },
        { to: "/gift-codes", label: "Gift codes", icon: Gift },
        ...PUBLIC_TOOLS,
      ],
    },
  ];

  if (allianceId) {
    sections.push({
      heading: "This alliance",
      items: [
        { to: `/alliance/${allianceId}`, label: "Overview", icon: Gauge, exact: true },
        { to: `/alliance/${allianceId}/leaderboard/vault`, label: "Leaderboard", icon: Trophy },
        { to: `/alliance/${allianceId}/attendance/vault`, label: "Attendance", icon: CalendarCheck },
        { to: `/alliance/${allianceId}/calendar`, label: "Calendar", icon: CalendarDays },
      ],
    });

    if (isAdmin) {
      sections.push({
        heading: "Manage this alliance",
        items: [
          { to: `/admin/alliances/${allianceId}/members`, label: "Members", icon: UsersRound },
          { to: `/admin/alliances/${allianceId}/settings`, label: "Channel setup", icon: Hash },
          { to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications", icon: Bell },
          { to: `/admin/alliances/${allianceId}/custom-events`, label: "Custom events", icon: CalendarDays },
          { to: `/admin/alliances/${allianceId}/schedule-boards`, label: "Schedule boards", icon: ClipboardList },
        ],
      });
    }
  }

  if (isAdmin) {
    const adminItems: NavItem[] = [{ to: "/admin", label: "All alliances", icon: Flag, exact: true }];
    if (ctx.isGlobal) {
      adminItems.push(
        { to: "/admin/permissions", label: "Manage admins", icon: KeyRound },
        { to: "/admin/permissions/audit-log", label: "Audit log", icon: ScrollText },
        { to: "/admin/gift-codes", label: "Gift codes (admin)", icon: Gift },
        { to: "/admin/themes", label: "Themes", icon: Palette },
      );
    }
    if (ctx.isOwner) {
      adminItems.push(
        { to: "/admin/backups", label: "Backups", icon: DatabaseBackup },
        { to: "/admin/system", label: "System Health", icon: Activity },
      );
    }
    sections.push({ heading: "Admin", items: adminItems });
  }

  return (
    <nav className="flex h-full flex-col gap-5 overflow-y-auto px-3 py-4">
      {sections.map((section, i) => (
        <div key={i}>
          {section.heading && <SectionLabel>{section.heading}</SectionLabel>}
          <div className="flex flex-col gap-[3px]">
            {section.items.map((item) => (
              <NavLink key={item.to} item={item} active={isActive(location.pathname, item)} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
