import mammoth from "mammoth";
import { marked } from "marked";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import TurndownService from "turndown";
// @ts-expect-error: @joplin/turndown-plugin-gfm ships no type declarations.
import { gfm } from "@joplin/turndown-plugin-gfm";
import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Document converter: DOCX, Markdown, HTML and plain text in, HTML, Markdown,
 * plain text or a PDF out.
 *
 * The honest scope of the PDF path: no HTML and CSS layout engine is available
 * to this module, so the PDF is a text flow rendering, not a screenshot of a
 * rendered page. HTML is reduced to a small block model (headings, paragraphs,
 * list items, quotes, code, rules, flattened table rows) and pdf-lib lays that
 * model out with real word wrapping, page breaks and page numbers. It reads
 * like a document, not like a print preview. The panel keeps a Print to PDF
 * button for anyone who needs the exact page.
 *
 * PDF text extraction lives in the panel, because pdfjs-dist needs a worker
 * and this module stays pure. `cleanExtractedText` is the pure half of that
 * job and is exercised by the tests here.
 */

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** What the input actually is, once sniffed or declared. */
export type InputKind = "docx" | "markdown" | "html" | "text";

/** What to produce. */
export type OutputKind = "html" | "markdown" | "text" | "pdf";

/** Paper the PDF renderer lays text onto. */
export type PageSizeName = "a4" | "letter";

/** A stretch of text inside a block, with the styles that survive to PDF. */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
}

export type BlockType =
  | "heading"
  | "paragraph"
  | "list-item"
  | "quote"
  | "code"
  | "rule"
  | "table-row";

/** One laid out chunk of the document. The whole block model is this shape. */
export interface Block {
  type: BlockType;
  runs: InlineRun[];
  /** Heading level 1 to 6, or list nesting depth starting at 1. */
  level?: number;
  /** List marker text, e.g. "3." or a bullet. */
  marker?: string;
  /** Blockquote nesting depth; drives indentation. */
  quoteDepth?: number;
  /** True when a table row came from th cells. */
  header?: boolean;
}

export interface PdfOptions {
  /** "a4" (default) or "letter". */
  pageSize?: string;
  /** Body text size in points. Headings scale off it. */
  fontSize?: number;
  /** Page margin in points. */
  margin?: number;
  /** Draw "2 / 7" at the foot of every page. Default true. */
  pageNumbers?: boolean;
  [key: string]: unknown;
}

export interface ConvertOptions extends PdfOptions {
  /** "auto" (default), "docx", "markdown", "html" or "text". */
  from?: string;
  /** "html" (default), "markdown", "text" or "pdf". */
  to?: string;
}

export interface PdfRenderResult {
  bytes: Uint8Array;
  pageCount: number;
}

/** Anything past this is a document nobody meant to convert in a tab. */
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;

const FROM_CHOICES = ["auto", "docx", "markdown", "html", "text"] as const;
const TO_CHOICES = ["html", "markdown", "text", "pdf"] as const;
const PAGE_SIZE_CHOICES = ["a4", "letter"] as const;

/* ------------------------------------------------------------------ */
/* html text helpers                                                   */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  bull: "•",
  middot: "·",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sect: "§",
  para: "¶",
  dagger: "†",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  larr: "←",
  rarr: "→",
  harr: "↔",
};

/** Decode the named and numeric entities that show up in real documents. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Elements whose contents are markup or metadata, never prose. */
const NON_PROSE =
  /<(script|style|head|title|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

function stripNonProse(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(NON_PROSE, "")
    .replace(/<\/?(script|style|head|title|noscript|template|svg|iframe)\b[^>]*>/gi, "")
    .replace(/<!(?!--)[^>]*>/g, "");
}

interface TagToken {
  kind: "tag";
  name: string;
  close: boolean;
  attrs: string;
}
interface TextToken {
  kind: "text";
  value: string;
}
type Token = TagToken | TextToken;

/**
 * Split HTML into tags and text without a DOM.
 *
 * Quoted attribute values are matched as units so a ">" inside one does not
 * end the tag early, which is exactly how the style attributes Word and
 * mammoth emit break a naive splitter.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) tokens.push({ kind: "text", value: html.slice(last, m.index) });
    tokens.push({
      kind: "tag",
      name: (m[2] ?? "").toLowerCase(),
      close: m[1] === "/",
      attrs: m[3] ?? "",
    });
    last = m.index + m[0].length;
  }
  if (last < html.length) tokens.push({ kind: "text", value: html.slice(last) });
  return tokens;
}

function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'>]+)`, "i");
  const m = re.exec(attrs);
  if (!m?.[1]) return undefined;
  return decodeEntities(m[1].replace(/^["']|["']$/g, ""));
}

/** The plain text of a run list. */
export function runsText(runs: InlineRun[]): string {
  return runs.map((run) => run.text).join("");
}

/* ------------------------------------------------------------------ */
/* html to the block model                                             */
/* ------------------------------------------------------------------ */

const FLUSH_TAGS = new Set([
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "aside",
  "figure",
  "figcaption",
  "form",
  "fieldset",
  "address",
  "dl",
  "dt",
  "dd",
  "tbody",
  "thead",
  "tfoot",
  "caption",
  "nav",
  "details",
  "summary",
]);

const ITALIC_TAGS = new Set(["i", "em", "cite", "var", "dfn"]);
const MONO_TAGS = new Set(["code", "kbd", "samp", "tt"]);

/**
 * Reduce HTML to the block model the PDF renderer and the text renderer both
 * read. Tolerant by design: unknown tags pass their text through, unclosed
 * tags do not lose the rest of the document, and tables flatten to tab
 * separated rows because a text flow has no columns.
 */
export function htmlToBlocks(html: string): Block[] {
  const tokens = tokenize(stripNonProse(html ?? ""));
  const blocks: Block[] = [];
  const lists: { ordered: boolean; index: number }[] = [];

  let current: Block | null = null;
  let bold = 0;
  let italic = 0;
  let mono = 0;
  let preDepth = 0;
  let quoteDepth = 0;
  let cells: string[] | null = null;
  let cellBuffer: string | null = null;
  let rowIsHeader = false;

  function flush(): void {
    const block = current;
    current = null;
    if (!block) return;
    if (block.type === "code") {
      const text = runsText(block.runs).replace(/^\n+/, "").replace(/\s+$/, "");
      if (text === "") return;
      block.runs = [{ text, mono: true }];
      blocks.push(block);
      return;
    }
    while (block.runs.length > 0) {
      const first = block.runs[0];
      if (!first) break;
      first.text = first.text.replace(/^[ \n]+/, "");
      if (first.text !== "") break;
      block.runs.shift();
    }
    while (block.runs.length > 0) {
      const last = block.runs[block.runs.length - 1];
      if (!last) break;
      last.text = last.text.replace(/[ \n]+$/, "");
      if (last.text !== "") break;
      block.runs.pop();
    }
    if (runsText(block.runs).trim() === "") return;
    blocks.push(block);
  }

  function startBlock(type: BlockType, extra: Partial<Block> = {}): void {
    flush();
    current = { type, runs: [], ...(quoteDepth > 0 ? { quoteDepth } : {}), ...extra };
  }

  function pushRun(run: InlineRun): void {
    if (cellBuffer !== null) {
      cellBuffer += run.text;
      return;
    }
    if (!current) startBlock(quoteDepth > 0 ? "quote" : "paragraph");
    current?.runs.push(run);
  }

  function pushText(raw: string): void {
    const decoded = decodeEntities(raw);
    if (preDepth > 0) {
      if (decoded === "") return;
      pushRun({ text: decoded, mono: true });
      return;
    }
    const text = decoded.replace(/\s+/g, " ");
    if (text === "") return;
    if (text === " ") {
      if (cellBuffer !== null) {
        if (cellBuffer !== "" && !cellBuffer.endsWith(" ")) cellBuffer += " ";
        return;
      }
      const last = current?.runs[current.runs.length - 1];
      if (!last || last.text.endsWith(" ") || last.text.endsWith("\n")) return;
    }
    const run: InlineRun = { text };
    if (bold > 0) run.bold = true;
    if (italic > 0) run.italic = true;
    if (mono > 0) run.mono = true;
    pushRun(run);
  }

  for (const token of tokens) {
    if (token.kind === "text") {
      pushText(token.value);
      continue;
    }
    const name = token.name;

    if (!token.close) {
      if (/^h[1-6]$/.test(name)) {
        startBlock("heading", { level: Number(name.slice(1)) });
        continue;
      }
      switch (name) {
        case "p":
          startBlock(quoteDepth > 0 ? "quote" : "paragraph");
          continue;
        case "br":
          pushRun({ text: "\n" });
          continue;
        case "hr":
          flush();
          blocks.push({ type: "rule", runs: [], ...(quoteDepth > 0 ? { quoteDepth } : {}) });
          continue;
        case "img": {
          const alt = attrValue(token.attrs, "alt");
          pushRun({ text: alt ? `[image: ${alt}]` : "[image]", italic: true });
          continue;
        }
        case "blockquote":
          flush();
          quoteDepth += 1;
          continue;
        case "pre":
          preDepth += 1;
          startBlock("code");
          continue;
        case "ul":
        case "ol": {
          flush();
          const start = Number(attrValue(token.attrs, "start") ?? "1");
          lists.push({ ordered: name === "ol", index: Number.isFinite(start) ? start : 1 });
          continue;
        }
        case "li": {
          const list = lists[lists.length - 1];
          let marker = "•";
          if (list?.ordered) {
            marker = `${list.index}.`;
            list.index += 1;
          }
          startBlock("list-item", { level: Math.max(1, lists.length), marker });
          continue;
        }
        case "table":
          flush();
          continue;
        case "tr":
          flush();
          cells = [];
          rowIsHeader = false;
          continue;
        case "td":
        case "th":
          cellBuffer = "";
          if (name === "th") rowIsHeader = true;
          continue;
        case "b":
        case "strong":
          bold += 1;
          continue;
        default:
          if (ITALIC_TAGS.has(name)) {
            italic += 1;
            continue;
          }
          if (MONO_TAGS.has(name)) {
            if (preDepth === 0) mono += 1;
            continue;
          }
          if (FLUSH_TAGS.has(name)) flush();
          continue;
      }
    }

    if (/^h[1-6]$/.test(name)) {
      flush();
      continue;
    }
    switch (name) {
      case "p":
      case "li":
        flush();
        continue;
      case "pre":
        preDepth = Math.max(0, preDepth - 1);
        flush();
        continue;
      case "blockquote":
        flush();
        quoteDepth = Math.max(0, quoteDepth - 1);
        continue;
      case "ul":
      case "ol":
        flush();
        lists.pop();
        continue;
      case "td":
      case "th":
        if (cells && cellBuffer !== null) cells.push(cellBuffer.replace(/\s+/g, " ").trim());
        cellBuffer = null;
        continue;
      case "tr": {
        const row = cells ?? [];
        cells = null;
        const text = row.join("\t");
        if (text.trim() !== "") {
          blocks.push({
            type: "table-row",
            runs: [{ text, ...(rowIsHeader ? { bold: true } : {}) }],
            ...(rowIsHeader ? { header: true } : {}),
            ...(quoteDepth > 0 ? { quoteDepth } : {}),
          });
        }
        rowIsHeader = false;
        continue;
      }
      case "table":
        flush();
        continue;
      case "b":
      case "strong":
        bold = Math.max(0, bold - 1);
        continue;
      default:
        if (ITALIC_TAGS.has(name)) {
          italic = Math.max(0, italic - 1);
          continue;
        }
        if (MONO_TAGS.has(name)) {
          if (preDepth === 0) mono = Math.max(0, mono - 1);
          continue;
        }
        if (FLUSH_TAGS.has(name)) flush();
        continue;
    }
  }

  flush();
  return blocks;
}

/* ------------------------------------------------------------------ */
/* format conversions                                                  */
/* ------------------------------------------------------------------ */

/** Markdown to HTML, GitHub flavored, synchronous. */
export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown ?? "", { async: false, gfm: true, breaks: false });
}

function turndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    strongDelimiter: "**",
    hr: "---",
    linkStyle: "inlined",
  });
  service.use(gfm);
  return service;
}

/** HTML to Markdown, tables and strikethrough included. */
export function htmlToMarkdown(html: string): string {
  const markdown = turndownService().turndown(html ?? "");
  return markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Render the block model as plain text, one blank line between blocks. */
export function blocksToText(blocks: Block[]): string {
  const parts: string[] = [];
  let previous: Block | null = null;
  for (const block of blocks) {
    if (previous) {
      const tight =
        (previous.type === "list-item" && block.type === "list-item") ||
        (previous.type === "table-row" && block.type === "table-row");
      parts.push(tight ? "\n" : "\n\n");
    }
    parts.push(renderBlockText(block));
    previous = block;
  }
  return parts
    .join("")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function renderBlockText(block: Block): string {
  const prefix = "> ".repeat(block.quoteDepth ?? 0);
  const text = runsText(block.runs);
  const withPrefix = (value: string): string =>
    value
      .split("\n")
      .map((line) => prefix + line)
      .join("\n");

  switch (block.type) {
    case "rule":
      return `${prefix}---`;
    case "list-item": {
      const indent = "  ".repeat(Math.max(0, (block.level ?? 1) - 1));
      return `${prefix}${indent}${block.marker ?? "•"} ${text}`;
    }
    default:
      return withPrefix(text);
  }
}

/** HTML to block aware plain text: headings, lists and tables keep their shape. */
export function htmlToText(html: string): string {
  return blocksToText(htmlToBlocks(html));
}

/** Plain text to HTML: blank lines become paragraphs, single breaks become br. */
export function textToHtml(text: string): string {
  const normalized = (text ?? "").replace(/\r\n?/g, "\n");
  const paragraphs = normalized.split(/\n{2,}/).filter((part) => part.trim() !== "");
  if (paragraphs.length === 0) return "";
  return paragraphs
    .map((part) => `<p>${escapeHtml(part.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

type MammothInput = Parameters<typeof mammoth.convertToHtml>[0];

/**
 * DOCX bytes to HTML through mammoth. Images come across as data URLs, which
 * is why the HTML output keeps pictures and the PDF output does not.
 *
 * Both input keys are passed on purpose: mammoth's Node build reads `buffer`
 * and its browser build reads `arrayBuffer`, and this module runs in both.
 */
export async function docxToHtml(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array)) {
    throw new ToolError(
      "unknown-format",
      "A Word document has to arrive as file bytes, not as text.",
      "Drop the .docx file onto the panel instead of pasting its contents.",
    );
  }
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer, buffer: bytes } as MammothInput);
    return result.value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ToolError(
      "docx-failed",
      `This file could not be read as a Word document: ${detail}`,
      "Open it in Word or Google Docs and save a fresh copy as .docx. Old .doc files and password protected documents cannot be read here.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* pdf text cleanup                                                    */
/* ------------------------------------------------------------------ */

/**
 * Tidy the raw text pdfjs hands back in the panel.
 *
 * Extraction gives one string per page with hard line breaks where the layout
 * wrapped, hyphens split across those breaks, page separators, and runs of
 * padding spaces used as columns. This puts it back into readable prose
 * without inventing paragraph boundaries that are not there.
 */
export function cleanExtractedText(text: string): string {
  return (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n\n")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\p{Cc}/gu, (control) => (control === "\n" || control === "\t" ? control : ""))
    .replace(/(\p{Ll})-\n(\p{L})/gu, "$1$2")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/* pdf rendering                                                       */
/* ------------------------------------------------------------------ */

const PAGE_SIZES: Record<PageSizeName, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

/**
 * Characters WinAnsi cannot encode but a document is full of. Anything else
 * outside the encoding becomes "?" rather than throwing, because one stray
 * glyph should not cost someone the whole PDF.
 */
const PDF_REPLACEMENTS: Record<string, string> = {
  "\t": "    ",
  "\u00A0": " ",
  "\u00AD": "",
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "―": "-",
  "−": "-",
  "←": "<-",
  "→": "->",
  "↔": "<->",
  "⇒": "=>",
  "≠": "!=",
  "≤": "<=",
  "≥": ">=",
  "≡": "=",
  "′": "'",
  "″": '"',
  "⁃": "-",
  "●": "•",
  "▪": "•",
  "\u200B": "",
  "\u200C": "",
  "\u200D": "",
  "\uFEFF": "",
};

/** Code points above Latin-1 that WinAnsi still encodes. */
const WINANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

/** Make text safe for the standard PDF fonts, keeping newlines intact. */
export function sanitizeForPdf(text: string): string {
  let out = "";
  for (const char of text) {
    const mapped = PDF_REPLACEMENTS[char];
    const value = mapped === undefined ? char : mapped;
    for (const piece of value) {
      const code = piece.codePointAt(0) ?? 0;
      if (piece === "\n") {
        out += piece;
      } else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
        out += piece;
      } else if (WINANSI_EXTRAS.has(code)) {
        out += piece;
      } else {
        out += "?";
      }
    }
  }
  return out;
}

export interface PdfFonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
  monoBold: PDFFont;
}

function fontFor(run: InlineRun, fonts: PdfFonts): PDFFont {
  if (run.mono) return run.bold ? fonts.monoBold : fonts.mono;
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

interface Piece {
  text: string;
  font: PDFFont;
  width: number;
}
interface Line {
  pieces: Piece[];
  width: number;
}

/**
 * Greedy word wrap across styled runs.
 *
 * Widths come from the embedded font rather than a character count, so a line
 * of capitals wraps where it actually stops fitting. A single word wider than
 * the column is broken by character instead of running off the margin.
 */
function wrapRuns(runs: InlineRun[], fonts: PdfFonts, size: number, maxWidth: number): Line[] {
  const lines: Line[] = [];
  let line: Line = { pieces: [], width: 0 };
  const column = Math.max(size, maxWidth);

  const add = (text: string, font: PDFFont): void => {
    const width = font.widthOfTextAtSize(text, size);
    line.pieces.push({ text, font, width });
    line.width += width;
  };
  const breakLine = (): void => {
    lines.push(line);
    line = { pieces: [], width: 0 };
  };
  const breakWord = (word: string, font: PDFFont): void => {
    let chunk = "";
    for (const char of word) {
      const next = chunk + char;
      if (chunk !== "" && line.width + font.widthOfTextAtSize(next, size) > column) {
        add(chunk, font);
        breakLine();
        chunk = char;
      } else {
        chunk = next;
      }
    }
    if (chunk !== "") add(chunk, font);
  };
  const place = (word: string, font: PDFFont): void => {
    const width = font.widthOfTextAtSize(word, size);
    const gap = line.pieces.length > 0 ? font.widthOfTextAtSize(" ", size) : 0;
    if (line.pieces.length > 0 && line.width + gap + width > column) breakLine();
    if (width > column) {
      breakWord(word, font);
      return;
    }
    add(line.pieces.length > 0 ? ` ${word}` : word, font);
  };

  for (const run of runs) {
    const font = fontFor(run, fonts);
    const segments = sanitizeForPdf(run.text).split("\n");
    segments.forEach((segment, index) => {
      if (index > 0) breakLine();
      for (const word of segment.split(/\s+/)) {
        if (word === "") continue;
        place(word, font);
      }
    });
  }
  if (line.pieces.length > 0) lines.push(line);
  return lines;
}

function normalizeChoice(
  value: unknown,
  allowed: readonly string[],
  fallback: string,
  id: string,
  label: string,
): string {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).toLowerCase();
  if (!allowed.includes(text)) {
    throw new ToolError(
      "bad-option",
      `${label} does not accept "${String(value)}".`,
      `Use one of: ${allowed.join(", ")} (option "${id}").`,
    );
  }
  return text;
}

function normalizeNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  id: string,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new ToolError(
      "bad-option",
      `${label} of ${String(value)} is outside the usable range.`,
      `Use a number between ${min} and ${max} (option "${id}").`,
    );
  }
  return num;
}

const LIST_INDENT = 18;
const QUOTE_INDENT = 22;
const CODE_INDENT = 10;

interface DrawParams {
  x: number;
  size: number;
  lineHeight: number;
  color?: ReturnType<typeof rgb>;
  /** Draw a quote bar at this x beside every line. */
  bar?: number;
  onFirstLine?: (baseline: number) => void;
}

/**
 * Lay the block model out as a PDF and report how many pages it took.
 *
 * This is a text flow renderer: it measures, wraps, breaks pages and numbers
 * them, and it deliberately does not attempt CSS. Anything a browser would
 * paint from a stylesheet (floats, columns, backgrounds, web fonts, images)
 * is out of scope, which is why the panel keeps a Print to PDF button for the
 * pixel exact case.
 */
export async function renderBlocksToPdf(
  blocks: Block[],
  opts: PdfOptions = {},
): Promise<PdfRenderResult> {
  const pageSize = normalizeChoice(
    opts.pageSize,
    PAGE_SIZE_CHOICES,
    "a4",
    "pageSize",
    "Page size",
  ) as PageSizeName;
  const size = normalizeNumber(opts.fontSize, 11, 6, 36, "fontSize", "Font size");
  const margin = normalizeNumber(opts.margin, 56, 18, 200, "margin", "Page margin");
  const pageNumbers = opts.pageNumbers !== false;

  const { width, height } = PAGE_SIZES[pageSize];
  const contentWidth = width - margin * 2;
  const bottom = margin;

  const pdf = await PDFDocument.create();
  const fonts: PdfFonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
  };

  const ink = rgb(0.09, 0.09, 0.11);
  const quiet = rgb(0.42, 0.42, 0.46);
  const hairline = rgb(0.78, 0.78, 0.8);

  let page = pdf.addPage([width, height]);
  let y = height - margin;

  const newPage = (): void => {
    page = pdf.addPage([width, height]);
    y = height - margin;
  };
  const need = (space: number): void => {
    if (y - space < bottom) newPage();
  };

  const drawLines = (lines: Line[], params: DrawParams): void => {
    lines.forEach((line, index) => {
      need(params.lineHeight);
      y -= params.lineHeight;
      if (index === 0) params.onFirstLine?.(y);
      if (params.bar !== undefined) {
        page.drawLine({
          start: { x: params.bar, y: y - params.size * 0.25 },
          end: { x: params.bar, y: y + params.size * 0.95 },
          thickness: 2,
          color: hairline,
        });
      }
      let cursor = params.x;
      for (const piece of line.pieces) {
        if (piece.text.trim() !== "") {
          page.drawText(piece.text, {
            x: cursor,
            y,
            size: params.size,
            font: piece.font,
            color: params.color ?? ink,
          });
        }
        cursor += piece.width;
      }
    });
  };

  for (const block of blocks) {
    const quoteInset = (block.quoteDepth ?? 0) * QUOTE_INDENT;
    const left = margin + quoteInset;
    const available = contentWidth - quoteInset;

    switch (block.type) {
      case "rule": {
        need(size);
        y -= size * 0.9;
        page.drawLine({
          start: { x: left, y },
          end: { x: width - margin, y },
          thickness: 0.75,
          color: hairline,
        });
        y -= size * 0.5;
        break;
      }
      case "heading": {
        const level = Math.min(6, Math.max(1, block.level ?? 1));
        const scale = level === 1 ? 1.9 : level === 2 ? 1.5 : level === 3 ? 1.25 : 1.1;
        const headingSize = size * scale;
        y -= size * 0.7;
        const runs = block.runs.map((run) => ({ ...run, bold: true }));
        drawLines(wrapRuns(runs, fonts, headingSize, available), {
          x: left,
          size: headingSize,
          lineHeight: headingSize * 1.3,
        });
        y -= size * 0.35;
        break;
      }
      case "code": {
        const codeSize = size * 0.92;
        const codeLeading = codeSize * 1.3;
        y -= size * 0.3;
        for (const raw of runsText(block.runs).split("\n")) {
          if (raw.trim() === "") {
            need(codeLeading);
            y -= codeLeading;
            continue;
          }
          drawLines(
            wrapRuns([{ text: raw, mono: true }], fonts, codeSize, available - CODE_INDENT),
            { x: left + CODE_INDENT, size: codeSize, lineHeight: codeLeading, color: quiet },
          );
        }
        y -= size * 0.5;
        break;
      }
      case "list-item": {
        const depth = Math.max(1, block.level ?? 1);
        const x = left + (depth - 1) * LIST_INDENT;
        const marker = sanitizeForPdf(block.marker ?? "•");
        const markerWidth = Math.max(
          fonts.regular.widthOfTextAtSize(`${marker}  `, size),
          size * 0.9,
        );
        drawLines(wrapRuns(block.runs, fonts, size, available - (x - left) - markerWidth), {
          x: x + markerWidth,
          size,
          lineHeight: size * 1.4,
          onFirstLine: (baseline) => {
            page.drawText(marker, { x, y: baseline, size, font: fonts.regular, color: ink });
          },
        });
        y -= size * 0.25;
        break;
      }
      case "table-row": {
        const tableSize = size * 0.9;
        const text = runsText(block.runs).split("\t").join("   ");
        drawLines(
          wrapRuns([{ text, mono: true, bold: block.header }], fonts, tableSize, available),
          { x: left, size: tableSize, lineHeight: tableSize * 1.35 },
        );
        y -= size * 0.15;
        break;
      }
      case "quote": {
        drawLines(wrapRuns(block.runs, fonts, size, available - CODE_INDENT), {
          x: left + CODE_INDENT,
          size,
          lineHeight: size * 1.4,
          color: quiet,
          bar: left,
        });
        y -= size * 0.6;
        break;
      }
      default: {
        drawLines(wrapRuns(block.runs, fonts, size, available), {
          x: left,
          size,
          lineHeight: size * 1.4,
        });
        y -= size * 0.6;
        break;
      }
    }
  }

  if (pageNumbers) {
    const pages = pdf.getPages();
    pages.forEach((sheet, index) => {
      const label = `${index + 1} / ${pages.length}`;
      const labelWidth = fonts.regular.widthOfTextAtSize(label, 9);
      sheet.drawText(label, {
        x: (width - labelWidth) / 2,
        y: margin / 2,
        size: 9,
        font: fonts.regular,
        color: quiet,
      });
    });
  }

  return { bytes: await pdf.save(), pageCount: pdf.getPageCount() };
}

/** The block model as PDF bytes. */
export async function blocksToPdf(blocks: Block[], opts: PdfOptions = {}): Promise<Uint8Array> {
  const result = await renderBlocksToPdf(blocks, opts);
  return result.bytes;
}

/** HTML straight through the block model into a text flow PDF. */
export async function htmlToPdf(html: string, opts: PdfOptions = {}): Promise<PdfRenderResult> {
  return renderBlocksToPdf(htmlToBlocks(html), opts);
}

/* ------------------------------------------------------------------ */
/* detection and entry point                                           */
/* ------------------------------------------------------------------ */

function bytesContain(bytes: Uint8Array, needle: string): boolean {
  const target = new TextEncoder().encode(needle);
  const first = target[0];
  if (first === undefined) return false;
  outer: for (let i = 0; i + target.length <= bytes.length; i += 1) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < target.length; j += 1) {
      if (bytes[i + j] !== target[j]) continue outer;
    }
    return true;
  }
  return false;
}

const HTML_TAG =
  /<(?:!doctype\s+html|html|head|body|div|span|p|h[1-6]|ul|ol|li|table|tr|td|th|a|img|br|hr|pre|blockquote|strong|em|section|article|main|figure|font)\b[^>]*>/i;
const MARKDOWN_SIGNAL =
  /(^|\n)[ \t]{0,3}(#{1,6}\s|[-*+][ \t]+\S|\d+\.[ \t]+\S|>[ \t]|```|~~~|\|.*\|)/;
const MARKDOWN_INLINE = /\[[^\]\n]+\]\([^)\s]+\)|(\*\*|__)[^\s*_][^*_]*\1/;

/**
 * Work out what the input is.
 *
 * DOCX is a zip, so the check is the PK magic plus the word/document.xml part
 * name, which sits in the zip directory as plain text and is therefore
 * readable without unzipping anything. A PDF is refused here on purpose:
 * reading one needs pdfjs, which the panel runs, not this module.
 */
export function detectInputKind(input: Uint8Array | string): InputKind {
  if (typeof input !== "string") {
    if (input.length >= 2 && input[0] === 0x50 && input[1] === 0x4b) {
      if (bytesContain(input, "word/document.xml")) return "docx";
      throw new ToolError(
        "unknown-format",
        "This is a zip archive, but not a Word document.",
        "Unzip it first and convert the document inside, or pick a .docx file.",
      );
    }
    if (bytesContain(input.subarray(0, 8), "%PDF-")) {
      throw new ToolError(
        "unknown-format",
        "This is a PDF, and reading one needs the text extractor in the panel.",
        "Use the Extract text button for PDFs. This converter takes DOCX, Markdown, HTML and plain text.",
      );
    }
    if (input.subarray(0, 1024).includes(0)) {
      throw new ToolError(
        "unknown-format",
        "This file is binary, so there is no document text to convert.",
        "Convert a .docx, .md, .html or .txt file, or paste the text in directly.",
      );
    }
    return detectInputKind(new TextDecoder().decode(input));
  }

  const text = input.trim();
  if (text === "") return "text";
  const looksHtml = HTML_TAG.test(text);
  const looksMarkdown = MARKDOWN_SIGNAL.test(text) || MARKDOWN_INLINE.test(text);
  if (looksHtml && (text.startsWith("<") || !looksMarkdown)) return "html";
  if (looksMarkdown) return "markdown";
  if (looksHtml) return "html";
  return "text";
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Convert one document.
 *
 * Everything routes through HTML as the middle format: DOCX and Markdown come
 * in through it, and Markdown, plain text and PDF go out of it. That keeps one
 * conversion path instead of twelve, and it is why "DOCX to Markdown" and
 * "Markdown to PDF" both work without a dedicated converter for each pair.
 */
export async function run(
  input: Uint8Array | string,
  opts: ConvertOptions = {},
): Promise<string | Record<string, string>> {
  const from = normalizeChoice(opts.from, FROM_CHOICES, "auto", "from", "Input format");
  const to = normalizeChoice(opts.to, TO_CHOICES, "html", "to", "Output format") as OutputKind;

  const measured = typeof input === "string" ? input.length : input.byteLength;
  if (measured > MAX_INPUT_BYTES) {
    throw new ToolError(
      "too-large",
      `That document is ${formatBytes(measured)}, past the ${formatBytes(MAX_INPUT_BYTES)} this page converts.`,
      "Split the document, or convert it in a desktop program. The limit exists because the whole conversion runs in this tab's memory.",
    );
  }
  const empty = typeof input === "string" ? input.trim() === "" : input.length === 0;
  if (empty) {
    throw new ToolError(
      "empty-input",
      "There is nothing to convert yet.",
      "Drop a .docx, .md, .html or .txt file onto the panel, or paste Markdown or HTML into the input.",
    );
  }

  const kind = from === "auto" ? detectInputKind(input) : (from as InputKind);
  if (kind === "docx" && typeof input === "string") {
    throw new ToolError(
      "unknown-format",
      "Word documents are binary, so pasted text cannot be one.",
      "Drop the .docx file onto the panel, or set the input format to Markdown, HTML or plain text.",
    );
  }

  let html: string;
  if (kind === "docx") {
    html = await docxToHtml(input as Uint8Array);
  } else {
    const text = typeof input === "string" ? input : new TextDecoder().decode(input);
    html = kind === "markdown" ? markdownToHtml(text) : kind === "html" ? text : textToHtml(text);
  }

  if (to === "html") return html;
  if (to === "markdown") return htmlToMarkdown(html);
  if (to === "text") return htmlToText(html);

  const { bytes, pageCount } = await htmlToPdf(html, opts);
  return {
    Pages: String(pageCount),
    Size: formatBytes(bytes.length),
    "Data URL": `data:application/pdf;base64,${bytesToBase64(bytes)}`,
  };
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  string | Record<string, string>,
  ConvertOptions
>;
