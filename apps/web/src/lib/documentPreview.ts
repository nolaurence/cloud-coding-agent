export type DocumentKind = "word" | "excel" | "powerpoint";

const DOCUMENT_EXTENSIONS: Record<DocumentKind, string> = {
  word: ".docx",
  excel: ".xlsx",
  powerpoint: ".pptx",
};

export function documentKindForPath(filePath: string): DocumentKind | undefined {
  const normalized = filePath.toLowerCase();
  return (Object.entries(DOCUMENT_EXTENSIONS) as Array<[DocumentKind, string]>)
    .find(([, extension]) => normalized.endsWith(extension))?.[0];
}
