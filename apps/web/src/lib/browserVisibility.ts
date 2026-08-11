export function shouldShowNativeBrowser(panelOpen: boolean, activeTab: string | null): boolean {
  return panelOpen && activeTab === "browser";
}
