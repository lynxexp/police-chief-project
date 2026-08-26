import { Link, useLocation, useParams } from "react-router-dom";
import type { AuthContext } from "../api/client";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** Defaults to prefix-match; set exact for items whose path is a
   * prefix of another item's (e.g. "/" vs "/alliance/1"). */
  exact?: boolean;
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
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
        active
          ? "bg-indigo-500/15 font-medium text-indigo-300"
          : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
      }`}
    >
      <span className="w-5 shrink-0 text-center" aria-hidden="true">
        {item.icon}
      </span>
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/** Sidebar nav content, shared by the desktop rail and the mobile drawer.
 * Builds its own section list from route params + auth tier rather than
 * being handed props, so every page gets full navigation for free just by
 * rendering <Layout> -- no per-page wiring. */
export function SidebarContent({ ctx, onNavigate }: { ctx: AuthContext; onNavigate: () => void }) {
  const location = useLocation();
  const { allianceId } = useParams<{ allianceId?: string }>();
  const isAdmin = ctx.tier !== "none";

  const sections: NavSection[] = [
    {
      items: [
        { to: "/", label: "Your profile", icon: "👤", exact: true },
        { to: "/gift-codes", label: "Gift codes", icon: "🎁" },
      ],
    },
  ];

  if (allianceId) {
    sections.push({
      heading: "This alliance",
      items: [
        { to: `/alliance/${allianceId}`, label: "Overview", icon: "📊", exact: true },
        { to: `/alliance/${allianceId}/leaderboard/vault`, label: "Leaderboard", icon: "🏆" },
        { to: `/alliance/${allianceId}/attendance/vault`, label: "Attendance", icon: "✅" },
        { to: `/alliance/${allianceId}/calendar`, label: "Calendar", icon: "📅" },
      ],
    });

    if (isAdmin) {
      sections.push({
        heading: "Manage this alliance",
        items: [
          { to: `/admin/alliances/${allianceId}/members`, label: "Members", icon: "👥" },
          { to: `/admin/alliances/${allianceId}/settings`, label: "Channel setup", icon: "⚙️" },
          { to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications", icon: "🔔" },
          { to: `/admin/alliances/${allianceId}/custom-events`, label: "Custom events", icon: "🗓️" },
          { to: `/admin/alliances/${allianceId}/schedule-boards`, label: "Schedule boards", icon: "📋" },
        ],
      });
    }
  }

  if (isAdmin) {
    const adminItems: NavItem[] = [{ to: "/admin", label: "All alliances", icon: "🏛️", exact: true }];
    if (ctx.isGlobal) {
      adminItems.push(
        { to: "/admin/permissions", label: "Manage admins", icon: "🛡️" },
        { to: "/admin/permissions/audit-log", label: "Audit log", icon: "📜" },
        { to: "/admin/gift-codes", label: "Gift codes (admin)", icon: "🎁" },
        { to: "/admin/themes", label: "Themes", icon: "🎨" },
      );
    }
    if (ctx.isOwner) {
      adminItems.push({ to: "/admin/backups", label: "Backups", icon: "💾" });
    }
    sections.push({ heading: "Admin", items: adminItems });
  }

  return (
    <nav className="flex h-full flex-col gap-5 overflow-y-auto px-3 py-4">
      {sections.map((section, i) => (
        <div key={i}>
          {section.heading && (
            <div className="mb-1.5 px-2.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
              {section.heading}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <NavLink key={item.to} item={item} active={isActive(location.pathname, item)} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
