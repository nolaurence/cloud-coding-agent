import { useEffect, useState } from "react";
import {
  ExternalLink,
  FileDiff,
  FolderTree,
  Gauge,
  Globe2,
  PanelRightClose,
  Plus,
  RefreshCw,
  SquareTerminal,
  X,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useApp, useThreadState } from "../lib/store";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FilesPanel } from "./workspace/FilesPanel";
import { GitPanel } from "./workspace/GitPanel";
import { TerminalPanel } from "./workspace/TerminalPanel";
import "./workspace/workspace.css";

type PanelTab = "browser" | "terminal" | "files" | "diff" | "context";

const panelOptions: {
  id: PanelTab;
  label: string;
  description: string;
  icon: typeof Globe2;
}[] = [
  { id: "browser", label: "浏览器", description: "查看 Agent 操作的浏览器。", icon: Globe2 },
  { id: "terminal", label: "终端", description: "在此工作区运行 Shell。", icon: SquareTerminal },
  { id: "files", label: "文件", description: "浏览和编辑工作区文件。", icon: FolderTree },
  { id: "diff", label: "差异", description: "检查并提交代码更改。", icon: FileDiff },
  { id: "context", label: "上下文", description: "查看会话消息与工具统计。", icon: Gauge },
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
  const [openTabs, setOpenTabs] = useState<PanelTab[]>([]);
  const [activeTab, setActiveTab] = useState<PanelTab | null>(null);
  const thread = useApp((state) => state.threads.find((candidate) => candidate.id === threadId));
  const draftOwner = useApp((state) => state.user?.username ?? "anonymous");
  const canManageWorkspace = thread?.access === "owner";

  const openTab = (tab: PanelTab) => {
    setOpenTabs((current) => current.includes(tab) ? current : [...current, tab]);
    setActiveTab(tab);
  };

  const closeTab = (tab: PanelTab) => {
    const index = openTabs.indexOf(tab);
    const next = openTabs.filter((candidate) => candidate !== tab);
    setOpenTabs(next);
    if (activeTab === tab) setActiveTab(next[index] ?? next[index - 1] ?? null);
  };

  const renderPanel = (tab: PanelTab) => {
    switch (tab) {
      case "browser":
        return <BrowserPanel threadId={threadId} />;
      case "terminal":
        return <TerminalPanel threadId={threadId} />;
      case "files":
        return projectId ? (
          <FilesPanel
            projectId={projectId}
            threadId={threadId}
            draftOwner={draftOwner}
            editable={canManageWorkspace}
          />
        ) : <Empty text="项目不存在" />;
      case "diff":
        return projectId ? (
          <GitPanel
            projectId={projectId}
            threadId={threadId}
            editable={canManageWorkspace}
          />
        ) : <Empty text="项目不存在" />;
      case "context":
        return <ContextPanel threadId={threadId} />;
    }
  };

  return (
    <Tabs
      value={activeTab ?? ""}
      onValueChange={(value) => setActiveTab(value as PanelTab)}
      className="flex h-full min-h-0 w-full flex-col gap-0 bg-white dark:bg-zinc-950"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          <TabsList variant="line" className="h-10 min-w-0 max-w-[calc(100%_-_2rem)] flex-none justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-none p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {openTabs.map((tab) => {
              const item = panelOptions.find((candidate) => candidate.id === tab)!;
              const selected = activeTab === tab;
              return (
                <div
                  key={item.id}
                  className={`group flex h-8 shrink-0 items-center rounded-md transition-colors ${selected ? "bg-zinc-100 text-zinc-950 dark:bg-zinc-800 dark:text-zinc-50" : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"}`}
                >
                  <TabsTrigger
                    value={item.id}
                    aria-label={item.label}
                    title={item.label}
                    className="h-8 flex-none rounded-r-none px-2 text-xs after:hidden data-active:bg-transparent dark:data-active:bg-transparent"
                  >
                    <item.icon className="h-3.5 w-3.5" />
                    <span>{item.label}</span>
                  </TabsTrigger>
                  <button
                    type="button"
                    className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                    aria-label={`关闭${item.label}标签`}
                    title={`关闭${item.label}`}
                    onClick={() => closeTab(item.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </TabsList>
          <PanelPicker openTabs={openTabs} onSelect={openTab} />
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭面板" title="关闭面板" onClick={onClose}>
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {openTabs.length === 0 ? (
          <PanelEmptyState onSelect={openTab} />
        ) : openTabs.map((tab) => (
          <TabsContent
            key={tab}
            value={tab}
            forceMount
            className="h-full data-[state=inactive]:hidden"
          >
            {renderPanel(tab)}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}

function PanelPicker({
  openTabs,
  onSelect,
}: {
  openTabs: PanelTab[];
  onSelect: (tab: PanelTab) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="添加面板" title="添加面板">
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={6}
          align="start"
          className="z-50 min-w-44 rounded-lg bg-white p-1.5 text-zinc-900 shadow-lg ring-1 ring-zinc-950/10 outline-none dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/10"
        >
          {panelOptions.map((item) => (
            <DropdownMenu.Item
              key={item.id}
              className="flex h-9 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800"
              onSelect={() => onSelect(item.id)}
            >
              <item.icon className="h-4 w-4 shrink-0 text-zinc-500" />
              <span className="flex-1">{item.label}</span>
              {openTabs.includes(item.id) && <span className="text-[10px] text-zinc-400">已打开</span>}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function PanelEmptyState({ onSelect }: { onSelect: (tab: PanelTab) => void }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto p-5 sm:p-8">
      <div className="w-full max-w-2xl">
        <div className="mb-6 text-center">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">打开面板</h2>
          <p className="mt-1 text-xs text-zinc-500">选择要在右侧显示的内容</p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))] gap-2.5">
          {panelOptions.map((item) => (
            <button
              key={item.id}
              type="button"
              className="group min-h-28 rounded-lg border border-zinc-200 p-4 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
              onClick={() => onSelect(item.id)}
            >
              <item.icon className="mb-3 h-5 w-5 text-zinc-500 transition-colors group-hover:text-zinc-800 dark:group-hover:text-zinc-200" />
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{item.label}</div>
              <div className="mt-1 text-xs leading-5 text-zinc-500">{item.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
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
