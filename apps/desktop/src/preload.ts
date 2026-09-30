import { contextBridge, ipcRenderer } from "electron";

export interface BrowserViewBounds { x: number; y: number; width: number; height: number }
const browser = Object.freeze({
  attach: (threadId: string, ticket: string, bounds: BrowserViewBounds) => ipcRenderer.invoke("cca-browser-attach", { threadId, ticket, bounds }),
  updateBounds: (threadId: string, bounds: BrowserViewBounds) => ipcRenderer.send("cca-browser-bounds", { threadId, bounds }),
  setVisible: (threadId: string, visible: boolean) => ipcRenderer.send("cca-browser-visible", { threadId, visible }),
  detach: (threadId: string) => ipcRenderer.send("cca-browser-detach", threadId),
});
contextBridge.exposeInMainWorld("ccaDesktop", Object.freeze({
  platform: process.platform,
  localMode: true,
  selectFolder: () => ipcRenderer.invoke("cca-select-folder") as Promise<string | null>,
  windowControls: Object.freeze({
    minimize: () => ipcRenderer.invoke("cca-window-minimize") as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke("cca-window-toggle-maximize") as Promise<boolean>,
    close: () => ipcRenderer.invoke("cca-window-close") as Promise<void>,
  }),
  titleBarOverlay: (options: { color: string; symbolColor: string }) => {
    ipcRenderer.send("cca-window-titlebar-overlay", options);
  },
  browser,
}));
