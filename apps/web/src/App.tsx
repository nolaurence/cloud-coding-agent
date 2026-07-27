import { Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { AppLayout } from "./components/AppLayout";
import { NewChatPage } from "./pages/NewChatPage";
import { ThreadPage } from "./pages/ThreadPage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsLayout } from "./pages/settings/SettingsLayout";
import { GeneralSettings } from "./pages/settings/GeneralSettings";
import { ProvidersSettings } from "./pages/settings/ProvidersSettings";
import { McpSettings } from "./pages/settings/McpSettings";
import { SkillsSettings } from "./pages/settings/SkillsSettings";
import { UsersSettings } from "./pages/settings/UsersSettings";
import { ShareThreadPage } from "./pages/ShareThreadPage";
import { useApp } from "./lib/store";
import { useTheme } from "./lib/theme";

export default function App() {
  useTheme();
  const user = useApp((s) => s.user);
  const authReady = useApp((s) => s.authReady);

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
      <Route element={<AppLayout />}>
        <Route index element={<NewChatPage />} />
        <Route path="thread/:threadId" element={<ThreadPage />} />
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
              user.role === "admin" ? (
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
