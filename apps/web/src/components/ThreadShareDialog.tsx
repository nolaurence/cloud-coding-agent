import { useEffect, useState } from "react";
import type { ThreadShareMode, ThreadShareSummary } from "@cca/protocol";
import {
  Check,
  Copy,
  Eye,
  Link2,
  Link2Off,
  Loader2,
  MessagesSquare,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const emptyShare: ThreadShareSummary = { active: false, memberCount: 0 };

export function ThreadShareDialog({
  threadId,
  threadTitle,
  open,
  onOpenChange,
}: {
  threadId: string;
  threadTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const getThreadShare = useApp((state) => state.getThreadShare);
  const createThreadShare = useApp((state) => state.createThreadShare);
  const revokeThreadShare = useApp((state) => state.revokeThreadShare);
  const [share, setShare] = useState<ThreadShareSummary>(emptyShare);
  const [mode, setMode] = useState<ThreadShareMode>("readonly");
  const [shareUrl, setShareUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setShare(emptyShare);
    setShareUrl("");
    setCopied(false);
    setError("");
    void getThreadShare(threadId)
      .then((nextShare) => {
        if (cancelled) return;
        setShare(nextShare);
        setMode(nextShare.mode ?? "readonly");
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "获取分享状态失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getThreadShare, open, threadId]);

  const createShare = async () => {
    setSaving(true);
    setError("");
    setCopied(false);
    try {
      const created = await createThreadShare(threadId, mode);
      setShare(created);
      setShareUrl(`${window.location.origin}/share/${encodeURIComponent(created.token)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建分享链接失败");
    } finally {
      setSaving(false);
    }
  };

  const copyShareUrl = async () => {
    if (!shareUrl) return;
    setError("");
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("无法复制链接，请手动复制");
    }
  };

  const revokeShare = async () => {
    setConfirmRevoke(false);
    setSaving(true);
    setError("");
    try {
      await revokeThreadShare(threadId);
      setShare(emptyShare);
      setShareUrl("");
      setCopied(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "停止分享失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-x-hidden overflow-y-auto sm:max-w-md">
          <DialogHeader className="min-w-0 pr-8">
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-4 w-4" />
              分享会话
            </DialogTitle>
            <DialogDescription className="min-w-0 truncate" title={threadTitle}>
              {threadTitle}
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex h-28 items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" aria-label="正在获取分享状态" />
            </div>
          ) : (
            <div className="min-w-0 space-y-4">
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">访问权限</div>
                <div className="grid grid-cols-1 gap-1 rounded-lg bg-muted p-1 sm:grid-cols-2" role="radiogroup" aria-label="分享权限">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode === "readonly"}
                    className={cn(
                      "flex min-h-16 min-w-0 items-start gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      mode === "readonly"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setMode("readonly")}
                  >
                    <Eye className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">只读</span>
                      <span className="mt-0.5 block text-xs leading-4">查看对话内容</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode === "collaborate"}
                    className={cn(
                      "flex min-h-16 min-w-0 items-start gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      mode === "collaborate"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setMode("collaborate")}
                  >
                    <MessagesSquare className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">可加入</span>
                      <span className="mt-0.5 block text-xs leading-4">可发送消息操作 Agent</span>
                    </span>
                  </button>
                </div>
                {mode === "collaborate" && (
                  <div className="flex items-start gap-1.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>加入者可以让 Agent 修改项目文件并执行命令。</span>
                  </div>
                )}
              </div>

              {shareUrl ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">分享链接</div>
                  <div className="flex min-w-0 gap-2">
                    <Input
                      readOnly
                      value={shareUrl}
                      aria-label="分享链接"
                      className="min-w-0 flex-1 font-mono text-xs"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={copied ? "已复制" : "复制分享链接"}
                      title={copied ? "已复制" : "复制链接"}
                      onClick={() => void copyShareUrl()}
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">关闭后不再显示此链接，需要时可重新生成。</p>
                </div>
              ) : share.active ? (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <span>分享已启用 · {share.memberCount} 人已加入</span>
                  <span>{share.mode === "collaborate" ? "可加入" : "只读"}</span>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">当前会话尚未分享。</div>
              )}

              {error && (
                <div className="text-xs text-destructive" role="alert">
                  {error}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="sm:justify-between">
            {share.active ? (
              <Button
                type="button"
                variant="destructive"
                className="w-full sm:w-auto"
                disabled={loading || saving}
                onClick={() => setConfirmRevoke(true)}
              >
                <Link2Off className="h-4 w-4" />
                停止分享
              </Button>
            ) : (
              <span />
            )}
            <Button type="button" className="w-full sm:w-auto" disabled={loading || saving} onClick={() => void createShare()}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : share.active ? (
                <RotateCw className="h-4 w-4" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              {share.active ? "生成新链接" : "创建链接"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title="停止分享？"
        description="现有链接将立即失效，已加入的用户也会失去访问权限。"
        confirmLabel="停止分享"
        destructive
        onConfirm={() => void revokeShare()}
      />
    </>
  );
}
