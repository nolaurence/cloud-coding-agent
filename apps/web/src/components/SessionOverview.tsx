import { useEffect, useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Activity, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleCheck, CircleDashed, FileText, FolderOutput, Loader2, Pencil, Pin, Plus, RefreshCw, X } from "lucide-react";
import type { RuntimeResources, ThreadOverviewAnnotations, ThreadOverviewNote } from "@cca/protocol";
import { useApp, useThreadState } from "../lib/store";
import { request } from "../lib/client";
import { currentOverviewStep, overviewArtifacts, overviewChecks, overviewCommand, overviewPlan, shortOverviewText } from "../lib/sessionOverview";
import { Button } from "./ui/button";

function OverviewSection({ title, badge, children, actions, description }: {
  title: string; badge?: string; children: ReactNode; actions?: ReactNode; description?: string;
}) {
  const [open, setOpen] = useState(true);
  const contentId = useId();
  return (
    <section data-slot="overview-section">
      <div className="flex min-h-11 items-center gap-1 px-3">
        <h3 className="min-w-0 flex-1">
          <button type="button" aria-expanded={open} aria-controls={contentId} title={description} onClick={() => setOpen((value) => !value)}
            className="-ml-1 flex min-h-9 w-full items-center gap-2 rounded-md px-1 text-left text-[13px] font-medium text-label-1 outline-none transition-colors hover:text-label-2 focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronDown aria-hidden="true" className={`size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
            <span className="truncate">{title}</span>
            {badge && <span className="shrink-0 text-[12px] font-normal tabular-nums text-label-2">{badge}</span>}
          </button>
        </h3>
        {actions && <div className="flex shrink-0 items-center gap-1" onClick={() => setOpen(true)}>{actions}</div>}
      </div>
      {open && <div id={contentId} className="space-y-2.5 px-3 pb-3.5 text-[12px] leading-5 text-label-2">{children}</div>}
    </section>
  );
}

function OverviewAction({ children, className = "", ...props }: ComponentProps<"button">) {
  return <button title={props["aria-label"]} {...props} type="button"
    className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md text-label-2 outline-none transition-colors hover:bg-hover hover:text-label-1 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5 ${className}`}>
    {children}
  </button>;
}

function Editor({ initial, label, saving, onSave, onCancel }: {
  initial: string; label: string; saving: boolean; onSave: (text: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSave(value); }}>
    <textarea autoFocus aria-label={label} value={value} maxLength={4000} rows={4} disabled={saving}
      onChange={(event) => setValue(event.target.value)} className="w-full resize-y rounded-md border border-line-3 bg-background p-2 text-[12px] outline-none focus:border-ring" />
    <div className="flex justify-end gap-1">
      <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancel}>取消</Button>
      <Button type="submit" size="sm" disabled={saving || !value.trim()}>{saving ? "保存中…" : "保存"}</Button>
    </div>
  </form>;
}

function Source({ turnId, onJump }: { turnId?: string; onJump: (turnId: string) => void }) {
  return turnId ? <button type="button" onClick={() => onJump(turnId)} className="inline-flex min-h-6 items-center gap-1 rounded-sm text-[11px] text-label-3 outline-none hover:text-label-1 focus-visible:ring-2 focus-visible:ring-ring/50">
    查看所在回合<ArrowUpRight className="size-3" />
  </button> : null;
}

function bytes(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  return `${(value / 1024 ** 2).toFixed(0)} MiB`;
}

function ResourceMeter({ label, percent, value, detail }: { label: string; percent: number | null; value?: string; detail: string }) {
  return <div className="space-y-1" title={detail}>
    <div className="flex items-center justify-between gap-2"><span>{label}</span><span className="font-mono text-[12px] tabular-nums text-label-1">{value ?? (percent === null ? "—" : `${percent.toFixed(1)}%`)}</span></div>
    {percent !== null && <div className="h-0.5 overflow-hidden rounded-full bg-muted" role="progressbar"
      aria-label={label} aria-valuenow={Math.max(0, Math.min(100, percent))} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-[width] ${percent >= 90 ? "bg-amber-500" : "bg-label-3"}`} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>}
    <div className="text-[11px] leading-4 text-label-3">{detail}</div>
  </div>;
}

function ResourceCard({ threadId }: { threadId: string }) {
  const connected = useApp((state) => state.connected);
  const [resources, setResources] = useState<RuntimeResources | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let pending = false;
    const poll = async () => {
      if (disposed || pending || document.visibilityState === "hidden") return;
      pending = true;
      setLoading(true);
      try {
        const value = await request<RuntimeResources>({ type: "runtime.resources", threadId }, 10_000);
        if (!disposed) { setResources(value); setError(""); }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "资源指标暂不可用");
      } finally { pending = false; if (!disposed) setLoading(false); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    const onVisible = () => void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [threadId, connected, refresh]);
  const scope = resources?.scope === "pod" ? "Pod" : resources?.scope === "container" ? "容器" : resources?.scope === "host" ? "主机" : undefined;
  return <OverviewSection title="资源用量" badge={scope} description="显示当前运行环境的真实资源用量；百分比以资源上限或可用 CPU 为基准。" actions={
    <OverviewAction aria-label="刷新资源用量" disabled={loading || !connected} onClick={() => setRefresh((value) => value + 1)}>
      <RefreshCw className={loading ? "animate-spin" : ""} />
    </OverviewAction>
  }>
    {resources ? <>
      <ResourceMeter label="CPU 利用率" percent={resources.cpuPercent} detail={resources.cpuCores === null ? "CPU 采样中或暂不可用" : `${resources.cpuCores.toFixed(2)} 核${resources.cpuLimitCores ? ` / ${resources.cpuLimitCores.toFixed(2)} 核` : " · 未设置 CPU 上限"}`} />
      <ResourceMeter label="内存占用" percent={resources.memoryPercent} value={bytes(resources.memoryUsedBytes)} detail={resources.memoryLimitBytes ? `上限 ${bytes(resources.memoryLimitBytes)}${resources.memoryPercent !== null ? ` · ${resources.memoryPercent.toFixed(1)}%` : ""}` : "未设置内存上限"} />
      <div className="flex items-center justify-between gap-2 text-[10px] leading-4 text-label-3" title={`${resources.name ?? scope ?? "运行环境"} · ${resources.source} · 每 5 秒刷新`}>
        <span className="min-w-0 truncate">{resources.source} · 每 5 秒</span>
        <time className="shrink-0 tabular-nums" dateTime={new Date(resources.sampledAt).toISOString()}>{error || !connected ? "上次 " : ""}{new Date(resources.sampledAt).toLocaleTimeString("zh-CN")}</time>
      </div>
      {resources.notice && <p className="text-[11px] leading-4 text-label-3">{resources.notice}</p>}
    </> : <p className="text-label-3">{loading ? "正在读取真实资源指标…" : "资源指标暂不可用"}</p>}
    {(!connected || error) && <p role="status" className="text-[11px] text-amber-600 dark:text-amber-400">{!connected ? "连接已断开，指标已暂停更新" : error}</p>}
  </OverviewSection>;
}

export function SessionOverview({ threadId, onClose, onJump, onOpenChanges }: {
  threadId: string; onClose: () => void; onJump: (turnId: string) => void; onOpenChanges: () => void;
}) {
  const state = useThreadState(threadId);
  const thread = useApp((app) => app.threads.find((candidate) => candidate.id === threadId));
  const connected = useApp((app) => app.connected);
  const updateOverview = useApp((app) => app.updateThreadOverview);
  const respondPermission = useApp((app) => app.respondPermission);
  const annotations = thread?.overview;
  const notes = annotations?.notes ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [responding, setResponding] = useState(false);
  const plan = useMemo(() => overviewPlan(state.messages, state.activities), [state.messages, state.activities]);
  const artifacts = useMemo(() => overviewArtifacts(state.activities), [state.activities]);
  const checks = useMemo(() => overviewChecks(state.activities), [state.activities]);
  const firstRequest = state.messages.find((message) => message.role === "user");
  const latestRequest = [...state.messages].reverse().find((message) => message.role === "user");
  const latestReply = [...state.messages].reverse().find((message) => message.role === "assistant" && !message.streaming && message.text.trim());
  const awaitingReview = !state.running && latestReply && (!latestRequest || latestReply.createdAt >= latestRequest.createdAt);
  const excerpt = latestReply ? shortOverviewText(latestReply.text, 300) : "";
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const status = !connected ? "已断开" : !state.loaded ? "加载中" : state.pendingPermission ? "等待授权" : state.error ? "执行异常" : state.running ? "运行中" : awaitingReview ? "待验收" : "空闲";
  const goal = annotations?.goal || firstRequest?.text || thread?.title || "尚未设置目标";
  const save = async (change: Partial<ThreadOverviewAnnotations>) => {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const current = useApp.getState().threads.find((candidate) => candidate.id === threadId)?.overview;
      await updateOverview(threadId, { notes: current?.notes ?? [], ...current, ...change });
      setEditing(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const saveNote = (note: ThreadOverviewNote) => void save({ notes: notes.some((entry) => entry.id === note.id) ? notes.map((entry) => entry.id === note.id ? note : entry) : [...notes, note] });
  const decide = async (decision: "accept" | "decline") => {
    const pending = state.pendingPermission;
    if (!pending || responding) return;
    setResponding(true); setError("");
    try { await respondPermission(threadId, pending.requestId, decision); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "授权失败"); }
    finally { setResponding(false); }
  };
  return <aside aria-label="会话概览" className="flex h-full min-h-0 flex-col bg-background">
    <div className="flex h-14 shrink-0 items-center justify-between px-4">
      <h2 className="text-[12px] font-medium text-label-2" title="基于已加载的消息与工具事件，不额外调用模型。编辑的目标与结论随会话保存。">会话概览</h2>
      <OverviewAction aria-label="关闭会话概览" onClick={onClose}><X /></OverviewAction>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 [scrollbar-width:thin]">
      {error && <p role="alert" className="mb-2 rounded-lg border border-destructive/20 p-2 text-[12px] text-destructive">{error}</p>}
      <div data-slot="overview-surface" className="divide-y divide-line-2 overflow-hidden rounded-xl border border-line-2 bg-background shadow-[0_1px_4px_rgb(0_0_0/0.06)] dark:shadow-none">
      <OverviewSection title="当前概况" actions={
        <>
          <span title={status} aria-label={status} className="flex size-7 items-center justify-center text-label-3"><Activity className={`size-3.5 ${state.running ? "animate-pulse text-label-1" : ""}`} /></span>
          <OverviewAction disabled={saving || !connected} aria-label="编辑任务目标" onClick={() => setEditing("goal")}><Pencil /></OverviewAction>
        </>
      }>
        {editing === "goal" ? <Editor initial={goal} label="任务目标" saving={saving} onSave={(text) => void save({ goal: text })} onCancel={() => setEditing(null)} /> : <p className="line-clamp-2 whitespace-pre-wrap break-words text-label-1" title={goal}>{goal}</p>}
        <div className="flex items-start gap-2"><CircleDashed className={`mt-1 size-3.5 shrink-0 ${status === "运行中" ? "animate-spin text-label-1" : "text-label-3"}`} /><span className="line-clamp-2">{status === "运行中" ? currentOverviewStep(plan.steps, state.activities, state.subagents, state.running) : status === "待验收" ? "本轮回复已结束" : status === "空闲" ? "当前空闲" : status}</span></div>
        {state.contextUsage && <div className="flex flex-wrap items-center justify-between gap-x-2 text-[11px] leading-4 text-label-3"><span>上下文</span><span className="tabular-nums">{state.contextUsage.usedTokens.toLocaleString()} / {state.contextUsage.maxTokens.toLocaleString()} tokens</span></div>}
      </OverviewSection>

      {(state.pendingPermission || state.error || awaitingReview) && <OverviewSection title="需要你处理" badge={state.pendingPermission ? "待授权" : state.error ? "有阻塞" : undefined}>
        {state.pendingPermission ? <>
          <p>{state.pendingPermission.reason || "Agent 正在等待你的授权"}</p>
          {state.pendingPermission.command && <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-[11px]">{state.pendingPermission.command}</pre>}
          {state.pendingPermission.cwd && <p className="break-all text-[10px] text-label-3">目录：{state.pendingPermission.cwd}</p>}
          <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="outline" disabled={responding || !connected} onClick={() => void decide("decline")}>拒绝</Button><Button type="button" size="sm" disabled={responding || !connected} onClick={() => void decide("accept")}>允许</Button></div>
        </> : state.error ? <p className="break-words text-destructive">{state.error}</p> : <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><span>查看最新回复与验证记录</span><Source turnId={latestReply?.turnId} onJump={onJump} /></div>}
      </OverviewSection>}

      <OverviewSection title="关键结论" badge={notes.length ? String(notes.length) : undefined} actions={
        <OverviewAction disabled={saving || !connected || notes.length >= 50} aria-label="添加关键结论" onClick={() => setEditing("new")}><Plus /></OverviewAction>
      }>
        {editing === "new" && <Editor initial="" label="新增关键结论" saving={saving} onSave={(text) => saveNote({ id: crypto.randomUUID(), text, pinned: true })} onCancel={() => setEditing(null)} />}
        {[...notes].sort((left, right) => Number(right.pinned) - Number(left.pinned)).map((note) => <div key={note.id} className="group/note space-y-1">
          {editing === note.id ? <Editor initial={note.text} label="编辑关键结论" saving={saving} onSave={(text) => saveNote({ ...note, text })} onCancel={() => setEditing(null)} /> : <>
            <p className="whitespace-pre-wrap break-words text-label-1">{note.pinned && <Pin aria-label="已固定" className="mr-1.5 inline size-3 text-label-3" />}{note.text}</p>
            <div className="flex min-h-6 items-center justify-between gap-1"><Source turnId={note.sourceTurnId} onJump={onJump} /><div className="ml-auto flex transition-opacity [@media(hover:hover)]:opacity-0 group-hover/note:opacity-100 group-focus-within/note:opacity-100">
              <OverviewAction disabled={saving || !connected} aria-label={note.pinned ? "取消固定结论" : "固定结论"} onClick={() => saveNote({ ...note, pinned: !note.pinned })}><Pin /></OverviewAction>
              <OverviewAction disabled={saving || !connected} aria-label="编辑结论" onClick={() => setEditing(note.id)}><Pencil /></OverviewAction>
              <OverviewAction disabled={saving || !connected} aria-label="删除结论" onClick={() => void save({ notes: notes.filter((entry) => entry.id !== note.id) })} className="hover:text-destructive"><X /></OverviewAction>
            </div></div>
          </>}
        </div>)}
        {excerpt && <div className={`space-y-1.5 ${notes.length ? "border-t border-line-1 pt-2.5" : ""}`}><p className="text-[11px] text-label-3">最近答复 · 未确认</p><p className="line-clamp-2 break-words" title={excerpt}>{excerpt}</p>
          <div className="flex items-center justify-between gap-2"><Source turnId={latestReply?.turnId} onJump={onJump} /><button type="button" disabled={saving || !connected || notes.length >= 50 || notes.some((note) => note.sourceTurnId === latestReply?.turnId && note.text === excerpt)}
            onClick={() => saveNote({ id: crypto.randomUUID(), text: excerpt, pinned: true, sourceTurnId: latestReply!.turnId })} className="inline-flex min-h-6 items-center gap-1 rounded-sm text-[11px] text-label-2 outline-none hover:text-label-1 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"><Plus className="size-3" />保存为结论</button></div>
        </div>}
        {!notes.length && !excerpt && editing !== "new" && <p className="flex items-center gap-2 text-label-3"><CircleDashed className="size-3.5" />还没有结论</p>}
      </OverviewSection>

      <OverviewSection title="任务进度" badge={plan.steps.length ? `${completed}/${plan.steps.length}` : undefined} description={`${plan.origin === "native" ? "来自 Agent 原生计划" : "来自答复中的勾选清单"}；步骤数不代表精确完成百分比。`}>
        {plan.steps.length ? <>
          <ol className="space-y-2">{plan.steps.map((step, index) => <li key={`${index}:${step.text}`} className="flex items-start gap-2">
            {step.status === "completed" ? <CircleCheck className="mt-1 size-3.5 shrink-0 text-label-3" /> : step.status === "in_progress" ? <Loader2 className={`mt-1 size-3.5 shrink-0 text-label-1 ${state.running ? "animate-spin" : ""}`} /> : <CircleDashed className="mt-1 size-3.5 shrink-0 text-label-3" />}
            <button type="button" onClick={() => onJump(step.turnId)} className="min-w-0 break-words text-left outline-none hover:text-label-1 focus-visible:underline" title="查看计划所在回合">{step.text}<span className="sr-only"> · {step.status === "completed" ? "已完成" : step.status === "in_progress" ? "进行中" : "待办"}</span></button>
          </li>)}</ol>
        </> : <p className="flex items-center gap-2 text-label-3"><CircleDashed className="size-3.5" />还没有任务计划</p>}
      </OverviewSection>

      <OverviewSection title="成果与验证" badge={artifacts.length ? String(artifacts.length) : undefined} description="已成功执行的文件操作不等同于当前 Git 差异。文档和命令行生成的文件也可在工作区中查看。">
        {artifacts.length > 0 && <div className="space-y-1"><ul className="max-h-40 space-y-1 overflow-y-auto">{artifacts.map((artifact) => <li key={artifact.path}><button type="button" title={`${artifact.path} · 查看操作所在回合`} onClick={() => onJump(artifact.turnId)} className="flex w-full items-center gap-2 rounded-sm text-left outline-none hover:text-label-1 focus-visible:ring-2 focus-visible:ring-ring/50"><FileText className="size-3.5 shrink-0 text-label-3" /><span className="truncate font-mono text-[11px]">{artifact.path}</span></button></li>)}</ul>
          <button type="button" onClick={onOpenChanges} className="inline-flex min-h-6 items-center gap-1 text-[11px] text-label-3 hover:text-label-1">查看当前 Git 差异<ArrowUpRight className="size-3" /></button></div>}
        {state.messages.some((message) => message.role === "assistant" && message.attachments?.length) && <div className="space-y-1"><p className="text-[10px] text-label-3">生成的附件</p>{state.messages.filter((message) => message.role === "assistant").flatMap((message) => (message.attachments ?? []).map((attachment) => <button type="button" key={`${message.id}:${attachment.id}`} onClick={() => onJump(message.turnId)} className="block w-full truncate text-left text-[11px] hover:text-primary">{attachment.displayName} ↗</button>))}</div>}
        {!artifacts.length && <p className="flex items-center gap-2 text-label-3"><FolderOutput className="size-3.5" />还没有文件输出</p>}
        <div className="space-y-2" title="验证记录来自真实执行的测试、构建或类型检查。没有记录不代表验证通过。">
          {checks.length ? <><p className="text-[11px] text-label-3">验证记录</p><ul className="max-h-48 space-y-2 overflow-y-auto">{[...checks].reverse().map((check) => <li key={check.id}><button type="button" onClick={() => onJump(check.turnId)} className="flex w-full items-start gap-2 text-left outline-none hover:text-label-1 focus-visible:underline" title="查看命令执行所在回合">
            {check.status === "complete" ? <Check className="mt-1 size-3.5 shrink-0 text-label-3" /> : check.status === "error" ? <X className="mt-1 size-3.5 shrink-0 text-destructive" /> : <Loader2 className="mt-1 size-3.5 shrink-0 animate-spin" />}
            <span className="min-w-0"><span className="block break-all font-mono text-[11px] leading-4">{shortOverviewText(overviewCommand(check), 160)}</span><span className="text-[10px] text-label-3">{check.status === "complete" ? "命令已结束 · 待检查输出" : check.status === "error" ? "执行失败／已中止" : "正在执行"}</span></span>
          </button></li>)}</ul></> : <p className="flex items-center gap-2 text-label-3"><CheckCheck className="size-3.5" />暂无验证记录</p>}
        </div>
      </OverviewSection>
      <ResourceCard threadId={threadId} />
      </div>
    </div>
  </aside>;
}
