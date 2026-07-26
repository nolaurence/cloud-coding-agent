import { lazy, Suspense, useEffect, useState } from "react";
import {
  Code2,
  ExternalLink,
  FileCode2,
  FolderTree,
  Globe2,
  PanelRightClose,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import type { GitDiffResult } from "@cca/protocol";
import { request } from "../lib/client";
import { useThreadState } from "../lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FilesPanel } from "./workspace/FilesPanel";
import "./workspace/workspace.css";

const TerminalPanel = lazy(async () => {
  const module = await import("./workspace/TerminalPanel");
  return { default: module.TerminalPanel };
});

type PanelTab = "browser" | "terminal" | "files" | "diff" | "context";

const tabs: { id: PanelTab; label: string; icon: typeof Globe2 }[] = [
  { id: "browser", label: "浏览器", icon: Globe2 },
  { id: "terminal", label: "终端", icon: TerminalSquare },
  { id: "files", label: "文件", icon: FolderTree },
  { id: "diff", label: "差异", icon: Code2 },
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

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as PanelTab)}
      className="flex h-full min-h-0 w-full flex-col gap-0 bg-white dark:bg-zinc-950"
    >
      <div className="flex h-11 shrink-0 items-center border-b border-zinc-200 px-1 dark:border-zinc-800">
        <TabsList variant="line" className="h-10 min-w-0 flex-1 justify-start overflow-x-auto rounded-none p-0">
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
        <TabsContent value="browser" className="h-full"><BrowserPanel /></TabsContent>
        <TabsContent value="terminal" className="h-full">
          <Suspense fallback={<Empty text="正在加载终端…" />}>
            <TerminalPanel threadId={threadId} />
          </Suspense>
        </TabsContent>
        <TabsContent value="files" className="h-full">
          {projectId ? <FilesPanel projectId={projectId} /> : <Empty text="项目不存在" />}
        </TabsContent>
        <TabsContent value="diff" className="h-full">
          {projectId ? <DiffPanel projectId={projectId} /> : <Empty text="项目不存在" />}
        </TabsContent>
        <TabsContent value="context" className="h-full"><ContextPanel threadId={threadId} /></TabsContent>
      </div>
    </Tabs>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-zinc-500">{text}</div>;
}

function BrowserPanel() {
  const [draft, setDraft] = useState("http://localhost:5173");
  const [url, setUrl] = useState("http://localhost:5173");
  const normalized = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  return (
    <div className="flex h-full flex-col">
      <form className="flex gap-1 border-b border-zinc-200 p-2 dark:border-zinc-800" onSubmit={(event) => { event.preventDefault(); setUrl(draft.trim()); }}>
        <Input className="min-w-0 flex-1 text-xs" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="预览地址" />
        <Button type="submit" variant="ghost" size="icon" aria-label="刷新预览" title="刷新预览"><RefreshCw className="h-3.5 w-3.5" /></Button>
        <Button asChild variant="ghost" size="icon">
          <a href={normalized} target="_blank" rel="noreferrer" aria-label="在新窗口打开" title="在新窗口打开"><ExternalLink className="h-3.5 w-3.5" /></a>
        </Button>
      </form>
      <iframe key={normalized} src={normalized} title="网页预览" className="min-h-0 flex-1 bg-white" sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" />
      <div className="border-t border-zinc-200 px-2 py-1 text-[10px] text-zinc-400 dark:border-zinc-800">目标站点禁止 iframe 时，请使用右上角新窗口打开。</div>
    </div>
  );
}

function DiffPanel({ projectId }: { projectId: string }) {
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [error, setError] = useState("");
  const load = () => void request<GitDiffResult>({ type: "project.diff", projectId }).then(setDiff).catch((reason) => setError(reason.message));
  useEffect(load, [projectId]);
  return <div className="flex h-full flex-col"><div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800"><span>{diff ? `${diff.files} 个文件 · +${diff.additions} -${diff.deletions}` : "Git 差异"}</span><Button type="button" variant="ghost" size="icon-xs" aria-label="刷新差异" title="刷新" onClick={load}><RefreshCw className="h-3.5 w-3.5" /></Button></div>{error ? <Empty text={error} /> : <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-xs leading-5">{diff?.patch || "暂无未提交差异"}</pre>}</div>;
}

function ContextPanel({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId);
  const characters = state.messages.reduce((sum, message) => sum + message.text.length + (message.reasoning?.length ?? 0), 0);
  return <div className="space-y-3 overflow-auto p-4 text-sm"><h3 className="font-semibold">会话上下文</h3><div className="grid grid-cols-2 gap-2">{[["消息", state.messages.length], ["工具调用", state.activities.length], ["字符数", characters], ["状态", state.running ? "运行中" : "空闲"]].map(([label, value]) => <div key={label} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><div className="text-xs text-zinc-500">{label}</div><div className="mt-1 font-medium">{value}</div></div>)}</div><div className="text-xs leading-5 text-zinc-500">字符数是当前可见历史的近似统计，不代表模型精确 token 用量。</div></div>;
}
