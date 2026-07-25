import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { NewChatPage } from "./pages/NewChatPage";
import { ThreadPage } from "./pages/ThreadPage";
import { SettingsLayout } from "./pages/settings/SettingsLayout";
import { GeneralSettings } from "./pages/settings/GeneralSettings";
import { ProvidersSettings } from "./pages/settings/ProvidersSettings";
import { McpSettings } from "./pages/settings/McpSettings";
import { SkillsSettings } from "./pages/settings/SkillsSettings";

export default function App() {
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
        </Route>
      </Route>
    </Routes>
  );
}
