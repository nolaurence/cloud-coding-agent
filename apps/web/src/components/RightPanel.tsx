import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Code2,
  ExternalLink,
  FileCode2,
  FolderTree,
  GitCommitHorizontal,
  Globe2,
  Loader2,
  PanelRightClose,
  RefreshCw,
} from "lucide-react";
import type { GitCommitResult, GitDiffResult } from "@cca/protocol";
import { request } from "../lib/client";
import { useApp, useThreadState } from "../lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DiffViewer } from "./workspace/DiffViewer";
import { FilesPanel } from "./workspace/FilesPanel";
import "./workspace/workspace.css";

type PanelTab = "browser" | "files" | "diff" | "context";

const tabs: { id: PanelTab; label: string; icon: typeof Globe2 }[] = [
  { id: "browser", label: "浏览器", icon: Globe2 },
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
        <TabsContent value="browser" className="h-full"><BrowserPanel /></TabsContent>
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
            <DiffPanel
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

function DiffPanel({
  projectId,
  threadId,
  editable,
}: {
  projectId: string;
  threadId: string;
  editable: boolean;
}) {
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [operation, setOperation] = useState<"pull" | "commit" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDiff(await request<GitDiffResult>({ type: "project.diff", projectId }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取 Git 差异失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setDiff(null);
    setCommitMessage("");
    setError("");
    setNotice("");
    void load();
  }, [load, threadId]);

  const pull = async () => {
    setOperation("pull");
    setError("");
    setNotice("");
    try {
      await request({ type: "project.git.pull", threadId, projectId }, 130_000);
      setNotice("代码已拉取到最新版本");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "拉取代码失败");
    } finally {
      setOperation(null);
    }
  };

  const commit = async () => {
    const message = commitMessage.trim();
    if (!message) return;
    setOperation("commit");
    setError("");
    setNotice("");
    try {
      const result = await request<GitCommitResult>({
        type: "project.git.commit",
        threadId,
        projectId,
        message,
      });
      setCommitMessage("");
      setNotice(`已创建提交 ${result.hash}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交代码失败");
    } finally {
      setOperation(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 items-center justify-between gap-2 border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
        <span className="min-w-0 truncate">
          {diff
            ? `${diff.branch ? `${diff.branch} · ` : ""}${diff.files} 个文件 · +${diff.additions} -${diff.deletions}`
            : "Git 差异"}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {editable && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={operation !== null}
              onClick={() => void pull()}
            >
              {operation === "pull" ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
              拉取
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="刷新差异"
            title="刷新"
            disabled={loading || operation !== null}
            onClick={() => void load()}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>
      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      ) : notice ? (
        <div className="border-b border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}
      <DiffViewer
        patch={diff?.patch}
        loading={loading && !diff}
        truncated={diff?.truncated ?? false}
        untrackedFiles={diff?.untrackedFiles ?? []}
        untrackedTotal={diff?.untracked ?? 0}
      />
      {editable && (
        <form
          className="flex shrink-0 gap-2 border-t border-zinc-200 p-2 dark:border-zinc-800"
          onSubmit={(event) => {
            event.preventDefault();
            void commit();
          }}
        >
          <Input
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            placeholder="输入提交说明"
            aria-label="提交说明"
            maxLength={2000}
            disabled={operation !== null}
            className="min-w-0 flex-1 text-xs"
          />
          <Button
            type="submit"
            size="sm"
            disabled={operation !== null || !commitMessage.trim() || !diff || diff.files === 0}
          >
            {operation === "commit" ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />}
            提交
          </Button>
        </form>
      )}
    </div>
  );
}

function ContextPanel({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId);
  const characters = state.messages.reduce((sum, message) => sum + message.text.length + (message.reasoning?.length ?? 0), 0);
  return <div className="space-y-3 overflow-auto p-4 text-sm"><h3 className="font-semibold">会话上下文</h3><div className="grid grid-cols-2 gap-2">{[["消息", state.messages.length], ["工具调用", state.activities.length], ["字符数", characters], ["状态", state.running ? "运行中" : "空闲"]].map(([label, value]) => <div key={label} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><div className="text-xs text-zinc-500">{label}</div><div className="mt-1 font-medium">{value}</div></div>)}</div><div className="text-xs leading-5 text-zinc-500">字符数是当前可见历史的近似统计，不代表模型精确 token 用量。</div></div>;
}
