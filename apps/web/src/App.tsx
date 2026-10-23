import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { AppLayout } from "./components/AppLayout";
import { DshPage } from "./pages/DshPage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsLayout } from "./pages/settings/SettingsLayout";
import { GeneralSettings } from "./pages/settings/GeneralSettings";
import { ProvidersSettings } from "./pages/settings/ProvidersSettings";
import { ConnectorsSettings } from "./pages/settings/ConnectorsSettings";
import { McpSettings } from "./pages/settings/McpSettings";
import { SkillsSettings } from "./pages/settings/SkillsSettings";
import { PluginsPage } from "./pages/PluginsPage";
import { UsersSettings } from "./pages/settings/UsersSettings";
import { ShareThreadPage } from "./pages/ShareThreadPage";
import { useApp } from "./lib/store";
import { useTheme } from "./lib/theme";

/** Revoke both the browser token and the server-side DSH portal session. */
function LogoutPage() {
  const logout = useApp((state) => state.logout);
  useEffect(() => {
    void fetch("/dsh/logout", { method: "POST" }).catch(() => undefined);
    logout();
  }, [logout]);
  return <Navigate to="/login" replace />;
}

export default function App() {
  useTheme();
  const user = useApp((s) => s.user);
  const localMode = useApp((s) => s.localMode);
  const authReady = useApp((s) => s.authReady);

  useEffect(() => {
    document.title = "Kloud Work";
  }, [localMode]);

  if (!authReady) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="share/:token" element={<ShareThreadPage />} />
      <Route index element={<DshPage key={user.username} />} />
      <Route path="thread/:threadId" element={<Navigate to="/" replace />} />
      <Route path="logout" element={<LogoutPage />} />
      <Route path="login" element={<Navigate to="/" replace />} />
      <Route element={<AppLayout />}>
        <Route
          path="skills"
          element={
            user.role === "admin" ? (
              <div className="h-full overflow-y-auto p-4 sm:p-6">
                <div className="mx-auto max-w-2xl">
                  <SkillsSettings />
                </div>
              </div>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="plugins"
          element={
            user.role === "admin" ? (
              <div className="h-full overflow-y-auto p-4 sm:p-6">
                <div className="mx-auto max-w-2xl">
                  <PluginsPage />
                </div>
              </div>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="general" replace />} />
          <Route path="general" element={<GeneralSettings />} />
          <Route
            path="providers"
            element={
              user.role === "admin" ? (
                <ProvidersSettings />
              ) : (
                <Navigate to="/settings/general" replace />
              )
            }
          />
          <Route
            path="connectors"
            element={
              user.role === "admin" ? (
                <ConnectorsSettings />
              ) : (
                <Navigate to="/settings/general" replace />
              )
            }
          />
          <Route
            path="mcp"
            element={
              user.role === "admin" ? (
                <McpSettings />
              ) : (
                <Navigate to="/settings/general" replace />
              )
            }
          />
          <Route
            path="users"
            element={
              user.role === "admin" && !localMode ? (
                <UsersSettings />
              ) : (
                <Navigate to="/settings/general" replace />
              )
            }
          />
          <Route path="skills" element={<Navigate to="/skills" replace />} />
          <Route path="git" element={<Navigate to="/settings/general" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
