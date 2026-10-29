import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleAlert, CircleCheck, CircleDashed, Cpu, FolderOutput, ListChecks, Loader2, NotebookPen, Pencil, Pin, Plus, RefreshCw, Target, X } from "lucide-react";
import type { RuntimeResources, ThreadOverviewAnnotations, ThreadOverviewNote } from "@cca/protocol";
import { useApp, useThreadState } from "../lib/store";
import { request } from "../lib/client";
import { currentOverviewStep, overviewArtifacts, overviewChecks, overviewCommand, overviewPlan, shortOverviewText } from "../lib/sessionOverview";
import { Button } from "./ui/button";

function Card({ title, icon: Icon, badge, children, actions }: {
  title: string; icon: typeof Target; badge?: string; children: ReactNode; actions?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded-xl border border-line-2 bg-background">
      <div className="flex items-center gap-1 px-3 py-2.5">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12px] font-medium text-label-1">
          <Icon className="size-3.5 shrink-0 text-label-3" />
          <span>{title}</span>
          {badge && <span className="ml-auto text-[11px] font-normal text-label-3">{badge}</span>}
          <ChevronDown className={`size-3 shrink-0 text-label-3 transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
        {actions}
      </div>
      {open && <div className="space-y-3 px-3 pb-3 text-[12px] leading-5 text-label-2">{children}</div>}
    </section>
  );
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
  return turnId ? <button type="button" onClick={() => onJump(turnId)} className="inline-flex items-center gap-0.5 text-[11px] text-label-3 hover:text-label-1">
    查看所在回合<ArrowUpRight className="size-3" />
  </button> : null;
}

function bytes(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  return `${(value / 1024 ** 2).toFixed(0)} MiB`;
}

function ResourceMeter({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  return <div className="space-y-1.5">
    <div className="flex items-center justify-between gap-2"><span>{label}</span><span className="font-mono tabular-nums text-label-1">{percent === null ? "—" : `${percent.toFixed(1)}%`}</span></div>
    <div className="h-1 overflow-hidden rounded-full bg-muted" role={percent === null ? undefined : "progressbar"}
      aria-label={label} aria-valuenow={percent === null ? undefined : Math.max(0, Math.min(100, percent))} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-[width] ${percent !== null && percent >= 90 ? "bg-amber-500" : "bg-primary/65"}`} style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} />
    </div>
    <div className="text-[11px] text-label-3">{detail}</div>
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
  const scope = resources?.scope === "pod" ? "当前 Pod" : resources?.scope === "container" ? "当前容器 / cgroup" : resources?.scope === "host" ? "当前主机" : "运行环境";
  return <Card title="资源用量" icon={Cpu} badge={scope} actions={
    <button type="button" aria-label="刷新资源用量" title="刷新资源用量" disabled={loading || !connected} onClick={() => setRefresh((value) => value + 1)} className="rounded p-1 text-label-3 hover:text-label-1 disabled:opacity-40">
      <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
    </button>
  }>
    {resources ? <>
      {resources.name && <div className="truncate font-mono text-[10px] text-label-3" title={resources.name}>{resources.name}</div>}
      <ResourceMeter label="CPU 利用率" percent={resources.cpuPercent} detail={resources.cpuCores === null ? "CPU 采样中或暂不可用" : `${resources.cpuCores.toFixed(2)} 核${resources.cpuLimitCores ? ` / ${resources.cpuLimitCores.toFixed(2)} 核` : " · 未设置 CPU 上限"}`} />
      <ResourceMeter label="内存占用" percent={resources.memoryPercent} detail={`${bytes(resources.memoryUsedBytes)}${resources.memoryLimitBytes ? ` / ${bytes(resources.memoryLimitBytes)}` : " · 未设置内存上限"}`} />
      <p className="text-[10px] leading-4 text-label-3">{resources.source} · {error || !connected ? "上次成功采样" : "采样"} {new Date(resources.sampledAt).toLocaleTimeString("zh-CN") }<br />每 5 秒刷新；百分比以资源上限／可用 CPU 为基准。</p>
      {resources.notice && <p className="text-[10px] leading-4 text-label-3">{resources.notice}</p>}
    </> : <p className="text-label-3">{loading ? "正在读取真实资源指标…" : "资源指标暂不可用"}</p>}
    {(!connected || error) && <p role="status" className="text-[11px] text-amber-600 dark:text-amber-400">{!connected ? "连接已断开，指标已暂停更新" : error}</p>}
  </Card>;
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
  return <aside aria-label="会话概览" className="flex h-full min-h-0 flex-col bg-panel">
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line-2 px-4">
      <ListChecks className="size-4 text-label-3" /><h2 className="flex-1 text-[13px] font-medium">会话概览</h2>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭会话概览" onClick={onClose}><X className="size-4" /></Button>
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 [scrollbar-width:thin]">
      {error && <p role="alert" className="rounded-lg border border-destructive/20 p-2 text-[12px] text-destructive">{error}</p>}
      <Card title="当前概况" icon={Target} badge={status} actions={
        <button type="button" disabled={saving || !connected} aria-label="编辑任务目标" onClick={() => setEditing("goal")} className="p-1 text-label-3 hover:text-label-1 disabled:opacity-40"><Pencil className="size-3" /></button>
      }>
        {editing === "goal" ? <Editor initial={goal} label="任务目标" saving={saving} onSave={(text) => void save({ goal: text })} onCancel={() => setEditing(null)} /> : <p className="line-clamp-4 whitespace-pre-wrap break-words text-label-1" title={goal}>{goal}</p>}
        <div className="flex items-start gap-2 border-t border-line-2 pt-2"><Activity className={`mt-1 size-3 shrink-0 ${state.running ? "text-primary" : "text-label-3"}`} /><span>{currentOverviewStep(plan.steps, state.activities, state.subagents, state.running)}</span></div>
        {state.contextUsage && <p className="text-[11px] text-label-3">上下文 {state.contextUsage.usedTokens.toLocaleString()} / {state.contextUsage.maxTokens.toLocaleString()} tokens</p>}
      </Card>

      {(state.pendingPermission || state.error || awaitingReview) && <Card title="需要你处理" icon={CircleAlert} badge={state.pendingPermission ? "待授权" : state.error ? "有阻塞" : "待验收"}>
        {state.pendingPermission ? <>
          <p>{state.pendingPermission.reason || "Agent 正在等待你的授权"}</p>
          {state.pendingPermission.command && <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-[11px]">{state.pendingPermission.command}</pre>}
          {state.pendingPermission.cwd && <p className="break-all text-[10px] text-label-3">目录：{state.pendingPermission.cwd}</p>}
          <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="outline" disabled={responding || !connected} onClick={() => void decide("decline")}>拒绝</Button><Button type="button" size="sm" disabled={responding || !connected} onClick={() => void decide("accept")}>允许</Button></div>
        </> : state.error ? <p className="break-words text-destructive">{state.error}</p> : <><p>Agent 已回复，请检查结果与验证记录。</p><Source turnId={latestReply?.turnId} onJump={onJump} /></>}
      </Card>}

      <Card title="关键结论" icon={NotebookPen} badge={`${notes.length} 条`} actions={
        <button type="button" disabled={saving || !connected || notes.length >= 50} aria-label="添加关键结论" onClick={() => setEditing("new")} className="p-1 text-label-3 hover:text-label-1 disabled:opacity-40"><Plus className="size-3.5" /></button>
      }>
        {editing === "new" && <Editor initial="" label="新增关键结论" saving={saving} onSave={(text) => saveNote({ id: crypto.randomUUID(), text, pinned: true })} onCancel={() => setEditing(null)} />}
        {[...notes].sort((left, right) => Number(right.pinned) - Number(left.pinned)).map((note) => <div key={note.id} className="space-y-1 border-b border-line-2 pb-2 last:border-0 last:pb-0">
          {editing === note.id ? <Editor initial={note.text} label="编辑关键结论" saving={saving} onSave={(text) => saveNote({ ...note, text })} onCancel={() => setEditing(null)} /> : <>
            <p className="whitespace-pre-wrap break-words">{note.pinned && <Pin className="mr-1 inline size-3 text-primary" />}{note.text}</p>
            <div className="flex items-center justify-between gap-1"><Source turnId={note.sourceTurnId} onJump={onJump} /><div className="ml-auto flex gap-1">
              <button type="button" disabled={saving || !connected} aria-label={note.pinned ? "取消固定结论" : "固定结论"} onClick={() => saveNote({ ...note, pinned: !note.pinned })} className="p-1 text-label-3 hover:text-label-1"><Pin className={`size-3 ${note.pinned ? "text-primary" : ""}`} /></button>
              <button type="button" disabled={saving || !connected} aria-label="编辑结论" onClick={() => setEditing(note.id)} className="p-1 text-label-3 hover:text-label-1"><Pencil className="size-3" /></button>
              <button type="button" disabled={saving || !connected} aria-label="删除结论" onClick={() => void save({ notes: notes.filter((entry) => entry.id !== note.id) })} className="p-1 text-label-3 hover:text-destructive"><X className="size-3" /></button>
            </div></div>
          </>}
        </div>)}
        {excerpt && <div className="space-y-1.5"><p className="text-[10px] text-label-3">最近答复摘录 · 未确认</p><p className="line-clamp-4 break-words">{excerpt}</p>
          <div className="flex items-center justify-between gap-2"><Source turnId={latestReply?.turnId} onJump={onJump} /><button type="button" disabled={saving || !connected || notes.length >= 50 || notes.some((note) => note.sourceTurnId === latestReply?.turnId && note.text === excerpt)}
            onClick={() => saveNote({ id: crypto.randomUUID(), text: excerpt, pinned: true, sourceTurnId: latestReply!.turnId })} className="text-[11px] text-primary disabled:opacity-40">保存为结论</button></div>
        </div>}
        {!notes.length && !excerpt && editing !== "new" && <p className="text-label-3">尚无结论。可添加已确认决策和约束；固定后不会被自动摘录覆盖。</p>}
      </Card>

      <Card title="任务进度" icon={ListChecks} badge={plan.steps.length ? `${completed} / ${plan.steps.length}` : undefined}>
        {plan.steps.length ? <>
          <p className="text-[10px] text-label-3">{plan.origin === "native" ? "来自 Agent 原生计划" : "来自答复中的勾选清单"} · 步骤数不代表精确完成百分比</p>
          <ol className="space-y-2">{plan.steps.map((step, index) => <li key={`${index}:${step.text}`} className="flex items-start gap-2">
            {step.status === "completed" ? <CircleCheck className="mt-1 size-3.5 shrink-0 text-emerald-600" /> : step.status === "in_progress" ? <Loader2 className={`mt-1 size-3.5 shrink-0 text-primary ${state.running ? "animate-spin" : ""}`} /> : <CircleDashed className="mt-1 size-3.5 shrink-0 text-label-3" />}
            <button type="button" onClick={() => onJump(step.turnId)} className={`text-left hover:text-primary ${step.status === "completed" ? "text-label-3" : ""}`} title="查看计划所在回合">{step.text}<span className="ml-1 text-[10px] text-label-3">{step.status === "completed" ? "已完成" : step.status === "in_progress" ? "进行中" : "待办"}</span></button>
          </li>)}</ol>
        </> : <p className="text-label-3">尚无结构化计划。Agent 更新计划或输出勾选清单后会显示在这里。</p>}
      </Card>

      <Card title="成果与验证" icon={FolderOutput} badge={`${artifacts.length} 个文件`}>
        {artifacts.length > 0 && <div className="space-y-1"><p className="text-[10px] text-label-3">已成功执行的文件操作（不等同于当前 Git 差异）</p><ul className="max-h-40 space-y-1 overflow-y-auto">{artifacts.map((artifact) => <li key={artifact.path}><button type="button" title={`${artifact.path} · 查看操作所在回合`} onClick={() => onJump(artifact.turnId)} className="block w-full truncate text-left font-mono text-[11px] hover:text-primary">{artifact.path}</button></li>)}</ul>
          <button type="button" onClick={onOpenChanges} className="text-[11px] text-primary">查看当前 Git 差异 ↗</button></div>}
        {state.messages.some((message) => message.role === "assistant" && message.attachments?.length) && <div className="space-y-1"><p className="text-[10px] text-label-3">生成的附件</p>{state.messages.filter((message) => message.role === "assistant").flatMap((message) => (message.attachments ?? []).map((attachment) => <button type="button" key={`${message.id}:${attachment.id}`} onClick={() => onJump(message.turnId)} className="block w-full truncate text-left text-[11px] hover:text-primary">{attachment.displayName} ↗</button>))}</div>}
        {!artifacts.length && <p className="text-label-3">尚未识别到文件改动。文档、命令行生成文件可能需要在工作区中查看。</p>}
        <div className="space-y-2 border-t border-line-2 pt-2"><p className="flex items-center gap-1 text-[11px] font-medium"><CheckCheck className="size-3.5" />验证记录</p>
          {checks.length ? <ul className="max-h-48 space-y-2 overflow-y-auto">{[...checks].reverse().map((check) => <li key={check.id}><button type="button" onClick={() => onJump(check.turnId)} className="flex w-full items-start gap-2 text-left" title="查看命令执行所在回合">
            {check.status === "complete" ? <Check className="mt-1 size-3 shrink-0 text-emerald-600" /> : check.status === "error" ? <X className="mt-1 size-3 shrink-0 text-destructive" /> : <Loader2 className="mt-1 size-3 shrink-0 animate-spin" />}
            <span className="min-w-0"><span className="block break-all font-mono text-[10px] leading-4">{shortOverviewText(overviewCommand(check), 160)}</span><span className="text-[10px] text-label-3">{check.status === "complete" ? "命令成功结束 · 仍需检查输出" : check.status === "error" ? "执行失败／已中止" : "正在执行"}</span></span>
          </button></li>)}</ul> : <p className="text-label-3">未发现已执行的测试、构建或类型检查，不代表验证通过。</p>}
        </div>
      </Card>
      <ResourceCard threadId={threadId} />
      <p className="px-1 pb-1 text-[10px] leading-4 text-label-3">概览基于已加载的真实消息与工具事件，不额外调用模型。编辑的目标与结论随会话保存。</p>
    </div>
  </aside>;
}
