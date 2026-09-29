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
  const raw = xmlText(cell, "v")[0] ?? "";
  if (type === "s") return sharedStrings[Number(raw)] ?? raw;
  if (type === "inlineStr") return xmlText(cell, "t").join("");
  return decodeXml(raw);
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function parseExcel(files: Record<string, Uint8Array>, relativePath: string): SpreadsheetDocumentPreview {
  const sharedStrings = parseSharedStrings(files);
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
      const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
        const cells: string[] = [];
        for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attributes = cellMatch[1] ?? "";
          const value = cellValue(`${cellMatch[0]}`, sharedStrings);
          const index = columnIndex(attributes.match(/\br="([A-Z]+\d+)"/)?.[1] ?? "A1");
          while (cells.length <= index) cells.push("");
          cells[index] = value;
        }
        return cells;
      });
      return { name: sheet.name, rows };
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
