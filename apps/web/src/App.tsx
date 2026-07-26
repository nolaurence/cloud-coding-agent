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
      <Route element={<AppLayout />}>
        <Route index element={<NewChatPage />} />
        <Route path="thread/:threadId" element={<ThreadPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="general" replace />} />
          <Route path="general" element={<GeneralSettings />} />
          <Route path="providers" element={<ProvidersSettings />} />
          <Route path="mcp" element={<McpSettings />} />
          <Route path="skills" element={<SkillsSettings />} />
          <Route path="git" element={<Navigate to="/settings/general" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
