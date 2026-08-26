import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProtectedRoute from "./components/ProtectedRoute";
import Login from "./pages/Login";
import GuildSelect from "./pages/GuildSelect";
import Profile from "./pages/Profile";
import AllianceOverview from "./pages/AllianceOverview";
import MemberDetail from "./pages/MemberDetail";
import Leaderboard from "./pages/Leaderboard";
import Attendance from "./pages/Attendance";
import AdminAlliances from "./pages/AdminAlliances";
import AdminMembers from "./pages/AdminMembers";
import AdminChannelSettings from "./pages/AdminChannelSettings";
import AdminPermissions from "./pages/AdminPermissions";
import AdminAuditLog from "./pages/AdminAuditLog";
import GiftCodes from "./pages/GiftCodes";
import AdminGiftCodes from "./pages/AdminGiftCodes";
import AdminBackups from "./pages/AdminBackups";
import AdminThemes from "./pages/AdminThemes";
import AdminThemeEditor from "./pages/AdminThemeEditor";
import AdminNotifications from "./pages/AdminNotifications";
import AdminNotificationCreate from "./pages/AdminNotificationCreate";
import AdminNotificationDetail from "./pages/AdminNotificationDetail";
import AdminCustomEvents from "./pages/AdminCustomEvents";
import AdminCustomEventCreate from "./pages/AdminCustomEventCreate";
import AdminCustomEventDetail from "./pages/AdminCustomEventDetail";
import AdminScheduleBoards from "./pages/AdminScheduleBoards";
import CalendarPage from "./pages/Calendar";

const queryClient = new QueryClient({
  defaultOptions: {
    // /api/auth/me is cheap (a couple of indexed lookups) and its
    // correctness matters more than saving a request -- always refetch
    // on mount/focus rather than trusting a stale cache for auth state.
    queries: { staleTime: 0, refetchOnWindowFocus: true, retry: false },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/select-guild" element={<GuildSelect />} />
            <Route path="/" element={<Profile />} />
            <Route path="/alliance/:allianceId" element={<AllianceOverview />} />
            <Route path="/alliance/:allianceId/members/:fid" element={<MemberDetail />} />
            <Route path="/alliance/:allianceId/leaderboard/:kind" element={<Leaderboard />} />
            <Route path="/alliance/:allianceId/attendance/:kind" element={<Attendance />} />
            <Route path="/alliance/:allianceId/calendar" element={<CalendarPage />} />
            <Route path="/admin" element={<AdminAlliances />} />
            <Route path="/admin/alliances/:allianceId/members" element={<AdminMembers />} />
            <Route path="/admin/alliances/:allianceId/settings" element={<AdminChannelSettings />} />
            <Route path="/admin/permissions" element={<AdminPermissions />} />
            <Route path="/admin/permissions/audit-log" element={<AdminAuditLog />} />
            <Route path="/gift-codes" element={<GiftCodes />} />
            <Route path="/admin/gift-codes" element={<AdminGiftCodes />} />
            <Route path="/admin/backups" element={<AdminBackups />} />
            <Route path="/admin/themes" element={<AdminThemes />} />
            <Route path="/admin/themes/:themeName" element={<AdminThemeEditor />} />
            <Route path="/admin/alliances/:allianceId/notifications" element={<AdminNotifications />} />
            <Route path="/admin/alliances/:allianceId/notifications/new" element={<AdminNotificationCreate />} />
            <Route path="/admin/alliances/:allianceId/notifications/:id" element={<AdminNotificationDetail />} />
            <Route path="/admin/alliances/:allianceId/custom-events" element={<AdminCustomEvents />} />
            <Route path="/admin/alliances/:allianceId/custom-events/new" element={<AdminCustomEventCreate />} />
            <Route path="/admin/alliances/:allianceId/custom-events/:id" element={<AdminCustomEventDetail />} />
            <Route path="/admin/alliances/:allianceId/schedule-boards" element={<AdminScheduleBoards />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
