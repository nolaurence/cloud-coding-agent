import { useEffect, useState } from "react";
import {
  ExternalLink,
  FileCode2,
  FolderTree,
  GitBranch,
  Globe2,
  PanelRightClose,
  RefreshCw,
} from "lucide-react";
import { useApp, useThreadState } from "../lib/store";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FilesPanel } from "./workspace/FilesPanel";
import { GitPanel } from "./workspace/GitPanel";
import "./workspace/workspace.css";

type PanelTab = "browser" | "files" | "diff" | "context";

const tabs: { id: PanelTab; label: string; icon: typeof Globe2 }[] = [
  { id: "browser", label: "浏览器", icon: Globe2 },
  { id: "files", label: "文件", icon: FolderTree },
  { id: "diff", label: "Git", icon: GitBranch },
  { id: "context", label: "上下文", icon: FileCode2 },
];

export function RightPanel({
  threadId,
  projectId,
  onClose,
}: {
  threadId: string;
  projectId?: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>("files");
  const thread = useApp((state) => state.threads.find((candidate) => candidate.id === threadId));
  const draftOwner = useApp((state) => state.user?.username ?? "anonymous");
  const canManageWorkspace = thread?.access === "owner";

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as PanelTab)}
      className="flex h-full min-h-0 w-full flex-col gap-0 bg-white dark:bg-zinc-950"
    >
      <div className="flex h-11 shrink-0 items-center border-b border-zinc-200 px-1 dark:border-zinc-800">
        <TabsList variant="line" className="h-10 min-w-0 flex-1 justify-start overflow-x-auto overflow-y-hidden rounded-none p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((item) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
              aria-label={item.label}
              title={item.label}
              className="h-10 flex-none px-2 text-xs"
            >
              <item.icon className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">{item.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭面板" title="关闭面板" onClick={onClose}>
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <TabsContent value="browser" className="h-full"><BrowserPanel threadId={threadId} /></TabsContent>
        <TabsContent value="files" className="h-full">
          {projectId ? (
            <FilesPanel
              projectId={projectId}
              threadId={threadId}
              draftOwner={draftOwner}
              editable={canManageWorkspace}
            />
          ) : <Empty text="项目不存在" />}
        </TabsContent>
        <TabsContent value="diff" className="h-full">
          {projectId ? (
            <GitPanel
              projectId={projectId}
              threadId={threadId}
              editable={canManageWorkspace}
            />
          ) : <Empty text="项目不存在" />}
        </TabsContent>
        <TabsContent value="context" className="h-full"><ContextPanel threadId={threadId} /></TabsContent>
      </div>
    </Tabs>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-zinc-500">{text}</div>;
}

function BrowserPanel({ threadId }: { threadId: string }) {
  const token = localStorage.getItem("cca-token") ?? "";
  const [reloadKey, setReloadKey] = useState(0);
  const [browser, setBrowser] = useState<{ ready: boolean; ticket?: string; error?: string } | null>(null);
  const issueTicket = async (signal?: AbortSignal) => {
    const response = await fetch("/api/browser/ticket", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId }),
      signal,
    });
    const data = await response.json() as { ticket?: string; error?: string };
    if (!response.ok || !data.ticket) throw new Error(data.error || "无法连接浏览器");
    return data.ticket;
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/browser/status?threadId=${encodeURIComponent(threadId)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const data = await response.json() as { ready?: boolean; error?: string };
        if (!response.ok) throw new Error(data.error || "无法获取浏览器状态");
        if (data.ready) {
          setBrowser({ ready: true, ticket: await issueTicket(controller.signal) });
        } else {
          setBrowser({ ready: false, error: data.error });
          timer = setTimeout(() => void load(), 1_000);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setBrowser({ ready: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    setBrowser(null);
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [reloadKey, threadId, token]);
  const openInNewWindow = () => {
    const popup = window.open("about:blank", "_blank", "noopener,noreferrer");
    if (!popup) {
      setBrowser((current) => ({ ready: false, error: current?.error || "浏览器阻止了新窗口" }));
      return;
    }
    void issueTicket().then((ticket) => {
      popup.location.href = browserUrl(ticket);
    }).catch((error) => {
      popup.close();
      setBrowser({ ready: false, error: error instanceof Error ? error.message : String(error) });
    });
  };
  const url = browser?.ticket ? browserUrl(browser.ticket) : "";
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-zinc-200 p-2 dark:border-zinc-800">
        <div className="min-w-0 flex-1 truncate px-2 text-xs text-zinc-500">Agent 浏览器</div>
        <Button type="button" variant="ghost" size="icon" onClick={() => setReloadKey((value) => value + 1)} aria-label="重新连接" title="重新连接"><RefreshCw className="h-3.5 w-3.5" /></Button>
        <Button type="button" variant="ghost" size="icon" disabled={!browser?.ready} onClick={openInNewWindow} aria-label="在新窗口打开" title="在新窗口打开"><ExternalLink className="h-3.5 w-3.5" /></Button>
      </div>
      {browser?.ready && url ? (
        <iframe key={reloadKey} src={url} title="Agent 浏览器" className="min-h-0 flex-1 bg-black" allow="clipboard-read; clipboard-write" />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-zinc-500">
          {browser?.error || "浏览器正在启动…"}
        </div>
      )}
      <div className="border-t border-zinc-200 px-2 py-1 text-[10px] text-zinc-400 dark:border-zinc-800">这里显示 Agent 通过 browser_use 操作的同一个 Chromium 会话。</div>
    </div>
  );
}

function browserUrl(ticket: string) {
  return `/novnc/vnc.html?${new URLSearchParams({
    autoconnect: "true",
    resize: "scale",
    reconnect: "false",
    path: `browser-vnc?ticket=${encodeURIComponent(ticket)}`,
  }).toString()}`;
}

function ContextPanel({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId);
  const characters = state.messages.reduce((sum, message) => sum + message.text.length + (message.reasoning?.length ?? 0), 0);
  return <div className="space-y-3 overflow-auto p-4 text-sm"><h3 className="font-semibold">会话上下文</h3><div className="grid grid-cols-2 gap-2">{[["消息", state.messages.length], ["工具调用", state.activities.length], ["字符数", characters], ["状态", state.running ? "运行中" : "空闲"]].map(([label, value]) => <div key={label} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><div className="text-xs text-zinc-500">{label}</div><div className="mt-1 font-medium">{value}</div></div>)}</div><div className="text-xs leading-5 text-zinc-500">字符数是当前可见历史的近似统计，不代表模型精确 token 用量。</div></div>;
}
