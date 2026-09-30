import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { DocumentPreview, SpreadsheetDocumentPreview, WordDocumentPreview } from "@cca/protocol";
import { readProjectBinary } from "./workspace.js";

const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function xmlEntry(files: Record<string, Uint8Array>, name: string): string {
  const data = files[name];
  return data ? strFromU8(data) : "";
}

function findZipEntry(files: Record<string, Uint8Array>, name: string): string | undefined {
  if (files[name]) return name;
  const lowerName = name.toLowerCase();
  return Object.keys(files).find((entry) => entry.toLowerCase() === lowerName);
}

function xmlAttributes(value: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of value.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)) {
    attributes.set(match[1] ?? "", decodeXml(match[3] ?? ""));
  }
  return attributes;
}

function resolveZipPath(source: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, "/");
  if (normalizedTarget.startsWith("/")) return path.posix.normalize(normalizedTarget).replace(/^\/+/, "");
  return path.posix.normalize(path.posix.join(path.posix.dirname(source), normalizedTarget)).replace(/^\.\//, "");
}

function parseRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*?)(?:\/?>)/gi)) {
    const attributes = xmlAttributes(match[1] ?? "");
    const id = attributes.get("Id");
    const target = attributes.get("Target");
    if (id && target) relationships.set(id, target);
  }
  return relationships;
}

function imageDataUrl(data: Uint8Array, entryName: string): string {
  const extension = path.posix.extname(entryName).toLowerCase();
  const mimeType = extension === ".jpg" || extension === ".jpeg"
    ? "image/jpeg"
    : extension === ".gif"
      ? "image/gif"
      : extension === ".webp"
        ? "image/webp"
        : extension === ".svg"
          ? "image/svg+xml"
          : "image/png";
  return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
}

function parseCellImages(files: Record<string, Uint8Array>): Map<string, { dataUrl: string; alt?: string }> {
  const partName = Object.keys(files).find((name) => /^xl\/cellimages\d*\.xml$/i.test(name));
  if (!partName) return new Map();
  const xml = xmlEntry(files, partName);
  const relsName = `${path.posix.dirname(partName)}/_rels/${path.posix.basename(partName)}.rels`;
  const relationshipsEntry = findZipEntry(files, relsName);
  const relationships = parseRelationships(relationshipsEntry ? xmlEntry(files, relationshipsEntry) : "");
  const imageById = new Map<string, { dataUrl: string; alt?: string }>();

  for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?cellImage\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?cellImage>/gi)) {
    const imageXml = match[0] ?? "";
    const embedId = imageXml.match(/\br:embed\s*=\s*["']([^"']+)["']/i)?.[1];
    const target = embedId ? relationships.get(embedId) : undefined;
    const entryName = target ? findZipEntry(files, resolveZipPath(partName, target)) : undefined;
    const data = entryName ? files[entryName] : undefined;
    if (!data || !entryName) continue;

    const ids = new Set<string>();
    for (const id of imageXml.matchAll(/\bID_[A-Za-z0-9_-]+\b/g)) ids.add(id[0]);
    const alt = imageXml.match(/\b(?:descr|title)\s*=\s*["']([^"']+)["']/i)?.[1];
    const resolved = { dataUrl: imageDataUrl(data, entryName), ...(alt ? { alt: decodeXml(alt) } : {}) };
    for (const id of ids) imageById.set(id, resolved);
  }

  return imageById;
}

function xmlText(xml: string, tag: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  for (const match of xml.matchAll(pattern)) {
    const value = decodeXml(match[1] ?? "").replace(/<[^>]+>/g, "").trim();
    if (value) values.push(value);
  }
  return values;
}

function parseWord(files: Record<string, Uint8Array>, relativePath: string): WordDocumentPreview {
  const xml = xmlEntry(files, "word/document.xml");
  if (!xml) throw new Error("Word 文档缺少正文内容");
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((match) => xmlText(match[1] ?? "", "w:t").join(""))
    .map((text) => text.trim())
    .filter(Boolean);
  return { kind: "word", path: relativePath, paragraphs };
}

function parseSharedStrings(files: Record<string, Uint8Array>): string[] {
  const xml = xmlEntry(files, "xl/sharedStrings.xml");
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
    .map((match) => xmlText(match[1] ?? "", "t").join(""));
}

function cellValue(cell: string, sharedStrings: string[]): string {
  const type = cell.match(/\bt="([^"]+)"/)?.[1];
  const formula = xmlText(cell, "f")[0];
  if (formula && /\bDISPIMG\s*\(/i.test(formula)) return `=${formula}`;
  const raw = xmlText(cell, "v")[0] ?? "";
  if (type === "s") return sharedStrings[Number(raw)] ?? raw;
  if (type === "inlineStr") return xmlText(cell, "t").join("");
  return decodeXml(raw);
}

function cellImageId(cell: string): string | undefined {
  const formula = xmlText(cell, "f")[0] ?? "";
  return decodeXml(formula).match(/\bDISPIMG\s*\(\s*["'](ID_[A-Za-z0-9_-]+)["']/i)?.[1];
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^\$?([A-Z]+)/i)?.[1]?.toUpperCase() ?? "A";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function parseExcel(files: Record<string, Uint8Array>, relativePath: string): SpreadsheetDocumentPreview {
  const sharedStrings = parseSharedStrings(files);
  const cellImages = parseCellImages(files);
  const workbook = xmlEntry(files, "xl/workbook.xml");
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/>/g)]
    .map((match) => ({ name: decodeXml(match[1] ?? "工作表"), relId: match[2] ?? "" }));
  const relationships = xmlEntry(files, "xl/_rels/workbook.xml.rels");
  const relationTargets = new Map(
    [...relationships.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g)]
      .map((match) => [match[1] ?? "", (match[2] ?? "").replace(/^\//, "")]),
  );
  const sheets = names.length > 0 ? names : [{ name: "工作表 1", relId: "rId1" }];
  return {
    kind: "excel",
    path: relativePath,
    sheets: sheets.map((sheet, index) => {
      const target = relationTargets.get(sheet.relId) ?? `xl/worksheets/sheet${index + 1}.xml`;
      const xml = xmlEntry(files, target.startsWith("xl/") ? target : `xl/${target}`);
      const images: NonNullable<SpreadsheetDocumentPreview["sheets"][number]["images"]> = [];
      const rows: string[][] = [];
      const rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gi;
      for (const rowMatch of xml.matchAll(rowPattern)) {
        const rowAttributes = rowMatch[1] ?? "";
        const declaredRow = Number(xmlAttributes(rowAttributes).get("r"));
        const rowIndex = Number.isInteger(declaredRow) && declaredRow > 0 ? declaredRow - 1 : rows.length;
        const cells = rows[rowIndex] ?? [];
        const rowXml = rowMatch[2] ?? "";
        for (const cellMatch of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
          const attributes = cellMatch[1] ?? "";
          const cellXml = cellMatch[0] ?? "";
          const image = cellImageId(cellXml);
          const reference = xmlAttributes(attributes).get("r") ?? "A1";
          const column = columnIndex(reference);
          while (cells.length <= column) cells.push("");
          cells[column] = image && cellImages.has(image) ? "" : cellValue(cellXml, sharedStrings);
          if (image) {
            const resolved = cellImages.get(image);
            if (resolved) images.push({ row: rowIndex, column, ...resolved });
          }
        }
        rows[rowIndex] = cells;
      }
      return { name: sheet.name, rows: rows.map((row) => row ?? []), ...(images.length > 0 ? { images } : {}) };
    }),
  };
}

function parsePowerPoint(files: Record<string, Uint8Array>, relativePath: string): DocumentPreview {
  const slideNames = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)/)?.[1]) - Number(right.match(/slide(\d+)/)?.[1]));
  return {
    kind: "powerpoint",
    path: relativePath,
    slides: slideNames.map((name, index) => ({ index: index + 1, text: xmlText(xmlEntry(files, name), "a:t") })),
  };
}

export function previewProjectDocument(root: string, relativePath: string): DocumentPreview {
  const extension = path.extname(relativePath).toLowerCase();
  if (!OFFICE_EXTENSIONS.has(extension)) throw new Error("仅支持 DOCX、XLSX 和 PPTX 文件");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(readProjectBinary(root, relativePath));
  } catch {
    throw new Error("Office 文件无法读取或已损坏");
  }
  if (extension === ".docx") return parseWord(files, relativePath);
  if (extension === ".xlsx") return parseExcel(files, relativePath);
  return parsePowerPoint(files, relativePath);
}
