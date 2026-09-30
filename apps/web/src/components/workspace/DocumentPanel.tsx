import { useEffect, useMemo, useState } from "react";
import { AlertCircle, FileText, FileSpreadsheet, Presentation, RefreshCw } from "lucide-react";
import type { DocumentPreview, ProjectFileEntry } from "@cca/protocol";
import { request } from "../../lib/client";
import { type DocumentKind } from "../../lib/documentPreview";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const EXTENSIONS: Record<DocumentKind, string> = {
  word: ".docx",
  excel: ".xlsx",
  powerpoint: ".pptx",
};

const TITLES: Record<DocumentKind, string> = {
  word: "Word 查看器",
  excel: "Excel 查看器",
  powerpoint: "PowerPoint 查看器",
};

export function DocumentPanel({ projectId, kind, filePath }: { projectId: string; kind: DocumentKind; filePath?: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error, setError] = useState("");
  const extension = EXTENSIONS[kind];

  const loadFiles = async () => {
    setLoadingFiles(true);
    setError("");
    if (filePath) {
      setFiles([filePath]);
      setSelectedPath(filePath);
      setLoadingFiles(false);
      return;
    }
    try {
      const entries = await request<ProjectFileEntry[]>({ type: "project.files", projectId });
      const matches = entries
        .filter((entry) => entry.kind === "file" && entry.path.toLowerCase().endsWith(extension))
        .map((entry) => entry.path)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      setFiles(matches);
      setSelectedPath((current) => matches.includes(current) ? current : matches[0] ?? "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文件列表加载失败");
    } finally {
      setLoadingFiles(false);
    }
  };

  useEffect(() => {
    setFiles([]);
    setSelectedPath("");
    setPreview(null);
    void loadFiles();
  }, [extension, filePath, projectId]);

  useEffect(() => {
    if (!selectedPath) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoadingPreview(true);
    setError("");
    void request<DocumentPreview>({ type: "project.document.preview", projectId, path: selectedPath })
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "文档读取失败"); })
      .finally(() => { if (!cancelled) setLoadingPreview(false); });
    return () => { cancelled = true; };
  }, [projectId, selectedPath]);

  const Icon = kind === "word" ? FileText : kind === "excel" ? FileSpreadsheet : Presentation;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 p-2 dark:border-zinc-800">
        <Icon className="h-4 w-4 shrink-0 text-zinc-500" />
        {filePath ? (
          <div className="min-w-0 flex-1 truncate px-2 text-xs text-zinc-600 dark:text-zinc-300" title={filePath}>{filePath}</div>
        ) : (
          <Select value={selectedPath} onValueChange={setSelectedPath} disabled={loadingFiles || files.length === 0}>
            <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" aria-label={`选择${TITLES[kind]}文件`}>
              <SelectValue placeholder={loadingFiles ? "正在加载文件…" : `选择 ${extension.toUpperCase()} 文件`} />
            </SelectTrigger>
            <SelectContent>
              {files.map((file) => <SelectItem key={file} value={file}>{file}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Button type="button" variant="ghost" size="icon-sm" aria-label="刷新文件列表" title="刷新文件列表" onClick={() => void loadFiles()}>
          <RefreshCw className={`h-3.5 w-3.5 ${loadingFiles ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        ) : loadingPreview ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-500">正在解析文档…</div>
        ) : !selectedPath ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-zinc-500">项目中暂无 {extension.toUpperCase()} 文件</div>
        ) : preview ? <PreviewContent preview={preview} /> : null}
      </div>
    </div>
  );
}

function PreviewContent({ preview }: { preview: DocumentPreview }) {
  if (preview.kind === "word") {
    return (
      <article className="mx-auto max-w-3xl px-7 py-8 text-[13px] leading-7 text-zinc-800 dark:text-zinc-200">
        {preview.paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 12)}`} className="mb-4">{paragraph}</p>)}
      </article>
    );
  }
  if (preview.kind === "excel") return <SpreadsheetPreview preview={preview} />;
  return (
    <div className="space-y-4 p-5">
      {preview.slides.map((slide) => (
        <section key={slide.index} className="aspect-video min-h-40 border border-zinc-200 bg-zinc-50 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-5 text-[10px] uppercase tracking-[0.18em] text-zinc-400">Slide {slide.index}</div>
          <div className="space-y-3 text-base leading-7 text-zinc-800 dark:text-zinc-100">
            {slide.text.map((text, index) => <p key={`${index}-${text.slice(0, 12)}`}>{text}</p>)}
          </div>
        </section>
      ))}
    </div>
  );
}

function SpreadsheetPreview({ preview }: { preview: Extract<DocumentPreview, { kind: "excel" }> }) {
  const [sheetName, setSheetName] = useState(preview.sheets[0]?.name ?? "");
  const sheet = useMemo(() => preview.sheets.find((candidate) => candidate.name === sheetName) ?? preview.sheets[0], [preview.sheets, sheetName]);
  const imageByCell = useMemo(
    () => new Map((sheet?.images ?? []).map((image) => [`${image.row}:${image.column}`, image] as const)),
    [sheet],
  );
  useEffect(() => setSheetName(preview.sheets[0]?.name ?? ""), [preview]);
  return (
    <div className="min-w-max p-4">
      <div className="mb-3 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {preview.sheets.map((candidate) => (
          <button key={candidate.name} type="button" className={`border-b-2 px-3 py-2 text-xs ${candidate.name === sheet?.name ? "border-emerald-500 text-zinc-900 dark:text-zinc-100" : "border-transparent text-zinc-500"}`} onClick={() => setSheetName(candidate.name)}>{candidate.name}</button>
        ))}
      </div>
      <table className="border-collapse text-xs">
        <tbody>
          {sheet?.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, columnIndex) => {
                const image = imageByCell.get(`${rowIndex}:${columnIndex}`);
                return (
                  <td key={columnIndex} className="min-w-24 border border-zinc-200 px-3 py-2 align-top dark:border-zinc-800">
                    {image ? (
                      <div className="flex max-h-40 max-w-48 items-center justify-center overflow-hidden bg-white p-1">
                        <img src={image.dataUrl} alt={image.alt ?? "单元格图片"} className="block max-h-36 max-w-44 object-contain" />
                      </div>
                    ) : value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
