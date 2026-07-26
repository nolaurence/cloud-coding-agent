import { useEffect, useMemo, useRef, useState } from "react";
import {
  Code2,
  ExternalLink,
  FileCode2,
  FolderTree,
  Globe2,
  PanelRightClose,
  RefreshCw,
  Send,
  TerminalSquare,
} from "lucide-react";
import type {
  GitDiffResult,
  ProjectFileContent,
  ProjectFileEntry,
  ServerMessage,
  TerminalEvent,
} from "@cca/protocol";
import { onEvent, request } from "../lib/client";
import { useThreadState } from "../lib/store";
import { cn } from "../lib/utils";

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
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex h-11 shrink-0 items-center border-b border-zinc-200 px-1 dark:border-zinc-800">
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              onClick={() => setTab(item.id)}
              className={cn(
                "flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-2 text-xs",
                tab === item.id
                  ? "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
              )}
            >
              <item.icon className="h-3.5 w-3.5" />
              <span className="hidden 2xl:inline">{item.label}</span>
            </button>
          ))}
        </div>
        <button type="button" title="关闭面板" className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={onClose}>
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "browser" && <BrowserPanel />}
        {tab === "terminal" && <TerminalPanel threadId={threadId} />}
        {tab === "files" && projectId && <FilesPanel projectId={projectId} />}
        {tab === "diff" && projectId && <DiffPanel projectId={projectId} />}
        {tab === "context" && <ContextPanel threadId={threadId} />}
        {!projectId && (tab === "files" || tab === "diff") && <Empty text="项目不存在" />}
      </div>
    </aside>
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
        <input className="h-8 min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-2 text-xs outline-none dark:border-zinc-700" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="预览地址" />
        <button className="rounded p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="刷新预览"><RefreshCw className="h-3.5 w-3.5" /></button>
        <a className="rounded p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800" href={normalized} target="_blank" rel="noreferrer" title="在新窗口打开"><ExternalLink className="h-3.5 w-3.5" /></a>
      </form>
      <iframe key={normalized} src={normalized} title="网页预览" className="min-h-0 flex-1 bg-white" sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" />
      <div className="border-t border-zinc-200 px-2 py-1 text-[10px] text-zinc-400 dark:border-zinc-800">目标站点禁止 iframe 时，请使用右上角新窗口打开。</div>
    </div>
  );
}

function TerminalPanel({ threadId }: { threadId: string }) {
  const terminalId = useMemo(() => `thread-${threadId}`, [threadId]);
  const [output, setOutput] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const handle = (message: ServerMessage) => {
      if (message.type !== "terminal.event" || message.event.terminalId !== terminalId) return;
      const event: TerminalEvent = message.event;
      if (event.kind === "output") setOutput((value) => (value + event.data).slice(-200_000));
      if (event.kind === "exit") setOutput((value) => `${value}\n[进程已退出: ${event.code ?? "未知"}]\n`);
    };
    const remove = onEvent(handle);
    void request<{ history: string }>({ type: "terminal.open", threadId, terminalId })
      .then((result) => setOutput(result.history))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "终端启动失败"));
    return () => { remove(); void request({ type: "terminal.close", terminalId }).catch(() => {}); };
  }, [terminalId, threadId]);
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [output]);
  const submit = async () => {
    if (!command.trim()) return;
    const value = command;
    setCommand("");
    try { await request({ type: "terminal.write", terminalId, data: `${value}\n` }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "命令发送失败"); }
  };
  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <pre ref={outputRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">{output || "正在启动终端…"}</pre>
      {error && <div className="px-3 py-1 text-xs text-red-400">{error}</div>}
      <form className="flex border-t border-zinc-800 p-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <span className="px-2 py-1 text-emerald-400">$</span>
        <input className="min-w-0 flex-1 bg-transparent px-1 font-mono text-xs outline-none" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="输入命令" />
        <button className="rounded p-1.5 hover:bg-zinc-800" title="执行"><Send className="h-3.5 w-3.5" /></button>
      </form>
    </div>
  );
}

function FilesPanel({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<ProjectFileEntry[]>([]);
  const [selected, setSelected] = useState<ProjectFileContent | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void request<ProjectFileEntry[]>({ type: "project.files", projectId }).then(setFiles).catch((reason) => setError(reason.message)); }, [projectId]);
  const open = (path: string) => void request<ProjectFileContent>({ type: "project.file.read", projectId, path }).then(setSelected).catch((reason) => setError(reason.message));
  return selected ? (
    <div className="flex h-full flex-col">
      <button type="button" className="truncate border-b border-zinc-200 px-3 py-2 text-left text-xs font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900" onClick={() => setSelected(null)}>← {selected.path}</button>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-xs leading-5">{selected.content}</pre>
    </div>
  ) : (
    <div className="h-full overflow-auto p-2">
      {error && <div className="p-2 text-xs text-red-500">{error}</div>}
      {files.map((entry) => <button key={entry.path} disabled={entry.kind === "directory"} onClick={() => open(entry.path)} className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs", entry.kind === "file" ? "hover:bg-zinc-100 dark:hover:bg-zinc-800" : "font-medium text-zinc-500")}><span>{entry.kind === "directory" ? "▾" : "·"}</span><span className="truncate">{entry.path}</span></button>)}
    </div>
  );
}

function DiffPanel({ projectId }: { projectId: string }) {
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [error, setError] = useState("");
  const load = () => void request<GitDiffResult>({ type: "project.diff", projectId }).then(setDiff).catch((reason) => setError(reason.message));
  useEffect(load, [projectId]);
  return <div className="flex h-full flex-col"><div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800"><span>{diff ? `${diff.files} 个文件 · +${diff.additions} -${diff.deletions}` : "Git 差异"}</span><button onClick={load} title="刷新"><RefreshCw className="h-3.5 w-3.5" /></button></div>{error ? <Empty text={error} /> : <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-xs leading-5">{diff?.patch || "暂无未提交差异"}</pre>}</div>;
}

function ContextPanel({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId);
  const characters = state.messages.reduce((sum, message) => sum + message.text.length + (message.reasoning?.length ?? 0), 0);
  return <div className="space-y-3 overflow-auto p-4 text-sm"><h3 className="font-semibold">会话上下文</h3><div className="grid grid-cols-2 gap-2">{[["消息", state.messages.length], ["工具调用", state.activities.length], ["字符数", characters], ["状态", state.running ? "运行中" : "空闲"]].map(([label, value]) => <div key={label} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><div className="text-xs text-zinc-500">{label}</div><div className="mt-1 font-medium">{value}</div></div>)}</div><div className="text-xs leading-5 text-zinc-500">字符数是当前可见历史的近似统计，不代表模型精确 token 用量。</div></div>;
}
