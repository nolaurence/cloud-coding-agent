import { useEffect, useMemo, type PropsWithChildren } from "react";
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { useTheme } from "../../lib/theme";

function WorkerThemeSync({ theme }: { theme: "pierre-light" | "pierre-dark" }) {
  const workerPool = useWorkerPool();
  useEffect(() => {
    void workerPool?.setRenderOptions({ theme }).catch((reason: unknown) => {
      console.error("代码高亮主题切换失败", reason);
    });
  }, [theme, workerPool]);
  return null;
}

export function DiffWorkerPoolProvider({ children }: PropsWithChildren) {
  const { resolvedTheme } = useTheme();
  const theme = resolveDiffThemeName(resolvedTheme);
  const poolOptions = useMemo(() => {
    const cores = typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency || 4;
    return {
      workerFactory: () => new DiffsWorker(),
      poolSize: Math.max(2, Math.min(6, Math.floor(cores / 2))),
      totalASTLRUCacheSize: 240,
    };
  }, []);

  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={{
        theme,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      }}
    >
      <WorkerThemeSync theme={theme} />
      {children}
    </WorkerPoolContextProvider>
  );
}
