import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser, LoaderCircle, Play, RotateCw, Square } from "lucide-react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ServerMessage, TerminalEvent, TerminalSnapshot } from "@cca/protocol";
import { onEvent, onReconnect, request } from "../../lib/client";
import { Button } from "@/components/ui/button";
import "@xterm/xterm/css/xterm.css";

type TerminalStatus = "opening" | "running" | "exited" | "closed" | "error";

interface TerminalActions {
  clear: () => void;
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

function getTerminalTheme(): ITheme {
  const dark = document.documentElement.classList.contains("dark");
  return dark
    ? {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#fafafa",
        cursorAccent: "#09090b",
        selectionBackground: "#3f3f4680",
        black: "#18181b",
        brightBlack: "#71717a",
        red: "#f87171",
        brightRed: "#fca5a5",
        green: "#4ade80",
        brightGreen: "#86efac",
        yellow: "#facc15",
        brightYellow: "#fde047",
        blue: "#60a5fa",
        brightBlue: "#93c5fd",
        magenta: "#c084fc",
        brightMagenta: "#d8b4fe",
        cyan: "#22d3ee",
        brightCyan: "#67e8f9",
        white: "#d4d4d8",
        brightWhite: "#fafafa",
      }
    : {
        background: "#ffffff",
        foreground: "#27272a",
        cursor: "#18181b",
        cursorAccent: "#ffffff",
        selectionBackground: "#d4d4d8a6",
        black: "#18181b",
        brightBlack: "#71717a",
        red: "#dc2626",
        brightRed: "#ef4444",
        green: "#15803d",
        brightGreen: "#16a34a",
        yellow: "#a16207",
        brightYellow: "#ca8a04",
        blue: "#2563eb",
        brightBlue: "#3b82f6",
        magenta: "#9333ea",
        brightMagenta: "#a855f7",
        cyan: "#0891b2",
        brightCyan: "#06b6d4",
        white: "#e4e4e7",
        brightWhite: "#fafafa",
      };
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

export function TerminalPanel({ threadId }: { threadId: string }) {
  const terminalId = useMemo(() => `thread-${threadId}`, [threadId]);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const openSessionRef = useRef<(() => Promise<void>) | null>(null);
  const actionsRef = useRef<TerminalActions | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("opening");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let active = false;
    let hydrating = false;
    let openingAttempt = 0;
    let bufferedOutput: string[] = [];
    const pendingOpenEvent: { exitCode: number | null | undefined } = { exitCode: undefined };
    let resizeTimer: number | undefined;
    let fitFrame: number | undefined;

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: getTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;

    const fit = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        // The container can briefly have no measurable size while tabs switch.
      }
    };

    const scheduleFit = () => {
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        fitFrame = undefined;
        fit();
      });
    };

    const appendExit = (code: number | null) => {
      active = false;
      setStatus("exited");
      terminal.write(`\r\n\x1b[90m[进程已退出：${code ?? "未知"}]\x1b[0m\r\n`);
    };

    const openSession = async () => {
      const attempt = ++openingAttempt;
      hydrating = true;
      active = false;
      bufferedOutput = [];
      pendingOpenEvent.exitCode = undefined;
      setStatus("opening");
      setError("");
      fit();

      try {
        const snapshot = await request<TerminalSnapshot>({
          type: "terminal.open",
          threadId,
          terminalId,
          cols: Math.min(500, Math.max(2, terminal.cols)),
          rows: Math.min(200, Math.max(1, terminal.rows)),
        });
        if (disposed || attempt !== openingAttempt) return;

        terminal.reset();
        if (snapshot.history) terminal.write(snapshot.history);
        for (const chunk of bufferedOutput) terminal.write(chunk);
        bufferedOutput = [];
        hydrating = false;
        setCwd(snapshot.cwd);
        if (pendingOpenEvent.exitCode !== undefined) {
          appendExit(pendingOpenEvent.exitCode);
        } else if (snapshot.running) {
          active = true;
          setStatus("running");
        } else {
          setStatus("exited");
        }
        scheduleFit();
        terminal.focus();
      } catch (reason) {
        if (disposed || attempt !== openingAttempt) return;
        hydrating = false;
        active = false;
        setStatus("error");
        setError(errorMessage(reason, "终端启动失败"));
      }
    };
    openSessionRef.current = openSession;

    const removeEvent = onEvent((message: ServerMessage) => {
      if (message.type !== "terminal.event" || message.event.terminalId !== terminalId) return;
      const event: TerminalEvent = message.event;
      if (event.kind === "output") {
        if (hydrating) bufferedOutput.push(event.data);
        else if (active) terminal.write(event.data);
      } else if (event.kind === "exit") {
        if (hydrating) pendingOpenEvent.exitCode = event.code;
        else appendExit(event.code);
      }
    });
    const removeReconnect = onReconnect(() => {
      void openSession();
    });

    const dataDisposable = terminal.onData((data: string) => {
      if (!active) return;
      for (let offset = 0; offset < data.length; offset += 60_000) {
        void request({ type: "terminal.write", terminalId, data: data.slice(offset, offset + 60_000) })
          .catch((reason) => {
            if (!disposed) setError(errorMessage(reason, "终端输入发送失败"));
          });
      }
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = undefined;
        if (!active || disposed) return;
        void request({ type: "terminal.resize", terminalId, cols, rows }).catch(() => {
          // Reconnect will reopen the session with the latest dimensions.
        });
      }, 80);
    });
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(host);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = getTerminalTheme();
      // 主题切换后强制重绘,避免浅色模式残留黑色背景
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    const clear = () => {
      terminal.clear();
      terminal.write("\x1b[2J\x1b[H");
      terminal.focus();
    };
    const restart = async () => {
      ++openingAttempt;
      hydrating = false;
      active = false;
      setStatus("opening");
      setError("");
      await request({ type: "terminal.close", terminalId }).catch(() => {});
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      if (!disposed) await openSession();
    };
    const close = async () => {
      ++openingAttempt;
      hydrating = false;
      active = false;
      setError("");
      try {
        await request({ type: "terminal.close", terminalId });
        if (!disposed) {
          setStatus("closed");
          terminal.write("\r\n\x1b[90m[终端已关闭]\x1b[0m\r\n");
        }
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason, "关闭终端失败"));
      }
    };

    actionsRef.current = { clear, restart, close };
    scheduleFit();
    void openSession();

    return () => {
      disposed = true;
      ++openingAttempt;
      removeEvent();
      removeReconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      terminal.dispose();
      terminalRef.current = null;
      openSessionRef.current = null;
      actionsRef.current = null;
      // Deliberately keep the backend session alive across tab and panel switches.
    };
  }, [terminalId, threadId]);

  const statusLabel = {
    opening: "连接中",
    running: "运行中",
    exited: "已退出",
    closed: "已关闭",
    error: "连接失败",
  }[status];

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-200 px-2 dark:border-zinc-800">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-zinc-500">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              status === "running"
                ? "bg-emerald-500"
                : status === "opening"
                  ? "animate-pulse bg-amber-500"
                  : "bg-zinc-400"
            }`}
          />
          <span className="shrink-0">{statusLabel}</span>
          {cwd && <span className="truncate font-mono text-zinc-400" title={cwd}>{cwd}</span>}
        </div>
        {status !== "running" && status !== "opening" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="启动终端"
            title="启动终端"
            onClick={() => void openSessionRef.current?.()}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-xs" aria-label="清屏" title="清屏" onClick={() => actionsRef.current?.clear()}>
          <Eraser className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="重启终端" title="重启终端" disabled={status === "opening"} onClick={() => void actionsRef.current?.restart()}>
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-zinc-500 hover:text-red-600 dark:hover:text-red-400"
          aria-label="关闭终端"
          title="关闭终端"
          disabled={status === "closed" || status === "opening"}
          onClick={() => void actionsRef.current?.close()}
        >
          <Square className="h-3 w-3 fill-current" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          className="workspace-terminal h-full w-full overflow-hidden"
          aria-label="终端"
          onClick={() => terminalRef.current?.focus()}
        />
        {status === "opening" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/70 text-xs text-zinc-500 dark:bg-zinc-950/70">
            <LoaderCircle className="mr-2 h-3.5 w-3.5 animate-spin" />
            正在连接终端…
          </div>
        )}
      </div>
      {error && (
        <div className="shrink-0 border-t border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
