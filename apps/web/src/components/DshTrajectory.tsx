import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { TrajectoryProjector, TrajectoryView, trajectoryTranslate, type TrajectoryViewProps } from "@cca/dsh-ui-trajectory";
import type { DshTrajectoryEvent, DshTrajectoryPage, DshTrajectoryQuery } from "@cca/protocol";
import { request } from "../lib/client";
import { useApp } from "../lib/store";
import { Button } from "./ui/button";

const DURATION_KEY = "cca-trajectory-actual-duration";

function readDuration(): boolean {
  try { return localStorage.getItem(DURATION_KEY) === "true"; }
  catch { return false; }
}

function mergeEvents(current: DshTrajectoryEvent[], incoming: DshTrajectoryEvent[]): DshTrajectoryEvent[] {
  if (!incoming.length) return current;
  const known = new Set(current.map(event => event.seq));
  const added = incoming.filter(event => !known.has(event.seq));
  return added.length ? [...current, ...added].sort((left, right) => left.seq - right.seq) : current;
}

interface HistoryState {
  events: DshTrajectoryEvent[];
  hasMoreBefore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

const noImages: TrajectoryViewProps["renderSlot"] = () => null;
const loadImage: TrajectoryViewProps["loadImage"] = async () => { throw new Error("图片预览暂不可用"); };
const completeViewRequest = () => {};

/** Native DSH trajectory; raw events are projected by the vendored DSH source. */
export default function DshTrajectory({ threadId, composerHeight }: { threadId: string; composerHeight: number }) {
  const connected = useApp(state => state.connected);
  const [history, setHistory] = useState<HistoryState>({ events: [], hasMoreBefore: false, loading: true, loadingOlder: false, error: null });
  const [actualDuration, setDuration] = useState(readDuration);
  const [retry, setRetry] = useState(0);
  const projector = useMemo(() => new TrajectoryProjector(), [threadId]);
  const cursor = useRef<number | null>(null);
  const revision = useRef<string | undefined>(undefined);
  const olderRequest = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const getPage = useCallback((query: DshTrajectoryQuery) =>
    request<DshTrajectoryPage>({ type: "thread.trajectory.load", threadId, ...query }, 20_000), [threadId]);

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        let query: DshTrajectoryQuery = cursor.current === null
          ? {}
          : { afterSeq: cursor.current, knownRevision: revision.current };
        for (;;) {
          const page = await getPage(query);
          if (stopped) return;
          const initial = cursor.current === null;
          if (!page.unchanged) {
            setHistory(previous => ({
              ...previous,
              events: mergeEvents(previous.events, page.events),
              hasMoreBefore: initial ? page.hasMoreBefore : previous.hasMoreBefore,
              loading: false,
              error: null,
            }));
          } else {
            setHistory(previous => previous.loading || previous.error ? { ...previous, loading: false, error: null } : previous);
          }
          cursor.current = page.events.at(-1)?.seq ?? cursor.current ?? -1;
          if (!page.hasMoreAfter || page.unchanged) {
            revision.current = page.revision;
            break;
          }
          query = { afterSeq: cursor.current };
        }
      } catch (error) {
        if (!stopped) setHistory(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "加载轨迹失败" }));
      } finally {
        // stat/revision avoids decoding unchanged native logs while this tab is idle.
        if (!stopped) timer = setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [connected, getPage, retry]);

  const loadOlder = useCallback(async () => {
    if (olderRequest.current || !history.hasMoreBefore) return false;
    const firstSeq = history.events[0]?.seq;
    if (firstSeq === undefined) return false;
    olderRequest.current = true;
    setHistory(previous => ({ ...previous, loadingOlder: true }));
    try {
      const page = await getPage({ beforeSeq: firstSeq });
      if (!mounted.current) return false;
      setHistory(previous => ({
        ...previous,
        events: mergeEvents(previous.events, page.events),
        hasMoreBefore: page.hasMoreBefore,
        loadingOlder: false,
        error: null,
      }));
      return page.events.length > 0;
    } catch (error) {
      if (mounted.current) setHistory(previous => ({ ...previous, loadingOlder: false, error: error instanceof Error ? error.message : "加载更早轨迹失败" }));
      return false;
    } finally {
      olderRequest.current = false;
    }
  }, [getPage, history.events, history.hasMoreBefore]);

  const snapshot = useMemo(() => projector.update(history.events, history.hasMoreBefore), [projector, history.events, history.hasMoreBefore]);
  const setActualDuration = (value: boolean) => {
    setDuration(value);
    try { localStorage.setItem(DURATION_KEY, String(value)); }
    catch { /* The in-memory preference remains usable when storage is disabled. */ }
  };
  const style = { "--dsh-composer-height": `${composerHeight}px` } as CSSProperties;

  return (
    <div className="flex h-full min-h-0 flex-col" style={style} data-dsh-trajectory>
      {history.error && (
        <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-sm text-red-500">
          <span>{history.error}</span>
          <Button size="sm" variant="outline" onClick={() => { revision.current = undefined; setRetry(value => value + 1); }}>重试</Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <TrajectoryView
          snapshot={snapshot}
          actualDuration={actualDuration}
          historyLoading={history.loading}
          olderHistoryLoading={history.loadingOlder}
          sessionHasOlderHistory={history.hasMoreBefore}
          loadOlder={loadOlder}
          loadImage={loadImage}
          setActualDuration={setActualDuration}
          viewRequest={null}
          completeViewRequest={completeViewRequest}
          renderSlot={noImages}
          t={trajectoryTranslate}
        />
      </div>
    </div>
  );
}
