import {
  EncryptedPDFError,
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
  type PDFForm,
} from 'pdf-lib';
import { ToolError, type ToolLogic } from '../types';

/**
 * PDF toolbox: merge, split, rotate, reorder, watermark, and fill forms.
 *
 * Everything here is pure bytes in, bytes out. pdf-lib runs identically in
 * Node and in the browser, so the tests exercise the same code path the page
 * does. Page previews need a canvas, so they live in the bespoke panel; this
 * module never renders anything.
 *
 * Page numbers in every public function are 1 based, because that is what a
 * person reads off a page and types into a range box.
 */

/** A page rotation this tool will apply. Quarter turns only, like every viewer. */
export type RotationAngle = 90 | 180 | 270;

/** Where a watermark sits on the page. */
export type WatermarkPosition = 'center' | 'diagonal' | 'bottom';

export interface WatermarkOptions {
  text: string;
  /** 0 is invisible, 1 is fully opaque. */
  opacity?: number;
  fontSize?: number;
  /** Degrees counterclockwise. Defaults to 45 for the diagonal position, else 0. */
  angle?: number;
  /** #rgb or #rrggbb. */
  color?: string;
  position?: WatermarkPosition;
}

export interface SplitPart {
  /** File name suffix, e.g. "pages-1-3" or "page-7". */
  suffix: string;
  /** The 1 based page numbers this part contains. */
  pages: number[];
  bytes: Uint8Array;
}

export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'dropdown'
  | 'radio'
  | 'option list'
  | 'button'
  | 'signature'
  | 'unknown';

export interface FormFieldInfo {
  name: string;
  type: FormFieldType;
  /** Current value, when the field has one. Checkboxes read "true" or "false". */
  value?: string;
  /** Selectable choices for dropdowns, radio groups, and option lists. */
  options?: string[];
}

export interface PageSizeSummary {
  /** Human label, e.g. "612 x 792 pt (Letter)". */
  label: string;
  count: number;
}

export interface PdfInfo {
  pageCount: number;
  pageSizes: PageSizeSummary[];
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  formFieldCount: number;
  byteLength: number;
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse PDF bytes, turning pdf-lib's failures into actionable ToolErrors.
 *
 * Every operation goes through here so the encrypted branch and the not a PDF
 * branch are reported the same way no matter which button was pressed.
 */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (!(bytes instanceof Uint8Array)) {
    throw new ToolError(
      'not-bytes',
      'This operation needs the raw bytes of a PDF file.',
      'Drop a .pdf file onto the input instead of typing text.',
    );
  }
  if (bytes.length === 0) {
    throw new ToolError(
      'empty-input',
      'That file is empty, so there is nothing to read.',
      'Pick a PDF file that has actual content in it.',
    );
  }
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) {
      throw new ToolError(
        'encrypted-pdf',
        'This PDF is password protected, so its pages cannot be read.',
        'Open it in a viewer that has the password, save an unprotected copy, then load that copy here. This tool cannot remove a password it does not have.',
      );
    }
    const detail = e instanceof Error ? e.message : String(e);
    throw new ToolError(
      'invalid-pdf',
      `That file could not be parsed as a PDF. ${detail}`,
      'Check that the file really is a PDF and that it downloaded completely, then try again.',
    );
  }
}

/* ------------------------------------------------------------------ */
/* page ranges                                                         */
/* ------------------------------------------------------------------ */

function resolveToken(token: string, pageCount: number, segment: string): number {
  const lower = token.trim().toLowerCase();
  if (lower === 'end' || lower === 'last') return pageCount;
  if (!/^\d+$/.test(lower)) {
    throw new ToolError(
      'invalid-range',
      `"${segment}" is not a page range.`,
      'Use page numbers, ranges like 4-9, and the word end, separated by commas. For example 1-3,7,9-end.',
    );
  }
  const n = Number(lower);
  if (n < 1) {
    throw new ToolError(
      'page-out-of-range',
      `Page ${n} does not exist: pages are numbered from 1.`,
      `Use a page number between 1 and ${pageCount}.`,
    );
  }
  if (n > pageCount) {
    throw new ToolError(
      'page-out-of-range',
      `Page ${n} does not exist: this PDF has ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}.`,
      `Use a page number between 1 and ${pageCount}.`,
    );
  }
  return n;
}

/**
 * Parse a range spec like "1-3,7,9-end" into one group of 1 based page numbers
 * per comma separated segment. Split makes one file per group, which is why the
 * grouping is preserved instead of being flattened into a single list.
 */
export function parsePageRanges(spec: string, pageCount: number): number[][] {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new ToolError(
      'no-pages',
      'That PDF reports no pages, so no range can be applied to it.',
      'Load a PDF that has at least one page.',
    );
  }
  const trimmed = (spec ?? '').trim();
  if (trimmed === '') {
    throw new ToolError(
      'empty-range',
      'No page range was given.',
      'Type something like 1-3,7,9-end. The word end means the last page.',
    );
  }

  const groups: number[][] = [];
  for (const raw of trimmed.split(',')) {
    const segment = raw.trim();
    if (segment === '') {
      throw new ToolError(
        'invalid-range',
        'That range has an empty section, so one of the commas has nothing after it.',
        'Remove the extra comma. A valid range looks like 1-3,7,9-end.',
      );
    }
    const dash = segment.indexOf('-');
    if (dash === -1) {
      groups.push([resolveToken(segment, pageCount, segment)]);
      continue;
    }
    const start = resolveToken(segment.slice(0, dash), pageCount, segment);
    const stop = resolveToken(segment.slice(dash + 1), pageCount, segment);
    if (start > stop) {
      throw new ToolError(
        'reversed-range',
        `"${segment}" runs backwards: page ${start} comes after page ${stop}.`,
        `Write it as ${stop}-${start} instead.`,
      );
    }
    const group: number[] = [];
    for (let n = start; n <= stop; n += 1) group.push(n);
    groups.push(group);
  }
  return groups;
}

/** Validate a plain list of 1 based page numbers, keeping the caller's order. */
function checkPages(pages: number[], pageCount: number, label: string): number[] {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new ToolError(
      'no-pages-selected',
      `No pages were selected for ${label}.`,
      `Choose at least one page between 1 and ${pageCount}.`,
    );
  }
  for (const n of pages) {
    if (!Number.isInteger(n) || n < 1 || n > pageCount) {
      throw new ToolError(
        'page-out-of-range',
        `Page ${n} does not exist: this PDF has ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}.`,
        `Use whole page numbers between 1 and ${pageCount}.`,
      );
    }
  }
  return pages;
}

/* ------------------------------------------------------------------ */
/* merge                                                               */
/* ------------------------------------------------------------------ */

/** Concatenate documents in the order given, keeping every page. */
export async function mergePdfs(docs: Uint8Array[]): Promise<Uint8Array> {
  if (!Array.isArray(docs) || docs.length === 0) {
    throw new ToolError(
      'no-documents',
      'No PDF files were given to merge.',
      'Add at least two PDF files, then drag them into the order you want.',
    );
  }
  const out = await PDFDocument.create();
  for (const bytes of docs) {
    const source = await loadPdf(bytes);
    const copied = await out.copyPages(source, source.getPageIndices());
    for (const page of copied) out.addPage(page);
  }
  if (out.getPageCount() === 0) {
    throw new ToolError(
      'no-pages',
      'Every file in the list has zero pages, so the merge produced nothing.',
      'Check the files you added: at least one of them needs a page.',
    );
  }
  return out.save();
}

/* ------------------------------------------------------------------ */
/* split                                                               */
/* ------------------------------------------------------------------ */

function suffixFor(pages: number[]): string {
  const first = pages[0]!;
  const last = pages[pages.length - 1]!;
  return first === last ? `page-${first}` : `pages-${first}-${last}`;
}

/**
 * Cut one document into several, one output per comma separated range.
 * "1-3,7,9-end" on a 12 page file yields three PDFs.
 */
export async function splitPdf(doc: Uint8Array, ranges: string): Promise<SplitPart[]> {
  const source = await loadPdf(doc);
  const groups = parsePageRanges(ranges, source.getPageCount());
  const parts: SplitPart[] = [];
  for (const pages of groups) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(
      source,
      pages.map((n) => n - 1),
    );
    for (const page of copied) out.addPage(page);
    parts.push({ suffix: suffixFor(pages), pages, bytes: await out.save() });
  }
  return parts;
}

/** Pull one range out as a single document, which is the common "extract" case. */
export async function extractPages(doc: Uint8Array, ranges: string): Promise<Uint8Array> {
  const source = await loadPdf(doc);
  const groups = parsePageRanges(ranges, source.getPageCount());
  const flat = groups.flat();
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    source,
    flat.map((n) => n - 1),
  );
  for (const page of copied) out.addPage(page);
  return out.save();
}

/* ------------------------------------------------------------------ */
/* rotate                                                              */
/* ------------------------------------------------------------------ */

/**
 * Turn pages by a quarter, half, or three quarter turn. The rotation is added
 * to whatever the page already had, because "rotate 90" means one more quarter
 * turn from where the reader is looking, not "set the angle to 90".
 */
export async function rotatePages(
  doc: Uint8Array,
  pages: number[] | 'all',
  angle: RotationAngle,
): Promise<Uint8Array> {
  if (angle !== 90 && angle !== 180 && angle !== 270) {
    throw new ToolError(
      'invalid-rotation',
      `${String(angle)} is not a rotation this tool can apply.`,
      'Pick 90, 180, or 270 degrees. PDF viewers only honor quarter turns.',
    );
  }
  const source = await loadPdf(doc);
  const pageCount = source.getPageCount();
  const targets =
    pages === 'all'
      ? Array.from({ length: pageCount }, (_, i) => i + 1)
      : checkPages(pages, pageCount, 'rotation');

  for (const n of new Set(targets)) {
    const page = source.getPage(n - 1);
    const current = page.getRotation().angle;
    page.setRotation(degrees((((current + angle) % 360) + 360) % 360));
  }
  return source.save();
}

/* ------------------------------------------------------------------ */
/* reorder and delete                                                  */
/* ------------------------------------------------------------------ */

/**
 * Rewrite the page order. The list is the finished document: pages you leave
 * out are deleted, so [3,1] on a five page file gives a two page file.
 *
 * Pages are moved inside the same document rather than copied into a new one,
 * which keeps the AcroForm, and therefore any form fields, intact.
 */
export async function reorderPages(doc: Uint8Array, order: number[]): Promise<Uint8Array> {
  const source = await loadPdf(doc);
  const pageCount = source.getPageCount();
  checkPages(order, pageCount, 'the new order');

  const seen = new Set<number>();
  for (const n of order) {
    if (seen.has(n)) {
      throw new ToolError(
        'duplicate-page',
        `Page ${n} is listed more than once.`,
        'List each page at most once. Leaving a page out of the list deletes it.',
      );
    }
    seen.add(n);
  }

  const pages = source.getPages();
  const picked = order.map((n) => pages[n - 1]!);
  for (let i = pageCount - 1; i >= 0; i -= 1) source.removePage(i);
  picked.forEach((page, i) => source.insertPage(i, page));
  return source.save();
}

/** Convenience wrapper: keep the current order, drop the listed pages. */
export async function deletePages(doc: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const source = await loadPdf(doc);
  const pageCount = source.getPageCount();
  checkPages(pages, pageCount, 'deletion');
  const drop = new Set(pages);
  const keep: number[] = [];
  for (let n = 1; n <= pageCount; n += 1) if (!drop.has(n)) keep.push(n);
  if (keep.length === 0) {
    throw new ToolError(
      'deletes-everything',
      'That would delete every page, and a PDF with no pages is not a valid file.',
      'Leave at least one page in the document.',
    );
  }
  return reorderPages(doc, keep);
}

/* ------------------------------------------------------------------ */
/* watermark                                                           */
/* ------------------------------------------------------------------ */

const WATERMARK_POSITIONS: WatermarkPosition[] = ['center', 'diagonal', 'bottom'];

/** Expand #rgb or #rrggbb into three 0 to 1 channels. */
function parseColor(raw: string): { r: number; g: number; b: number } {
  const body = raw.trim().replace(/^#/, '');
  const full = /^[0-9a-fA-F]{3}$/.test(body)
    ? body
        .split('')
        .map((c) => c + c)
        .join('')
    : body;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new ToolError(
      'invalid-color',
      `"${raw}" is not a hex color.`,
      'Use a value like #ff0000 or #f00.',
    );
  }
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

/** Where the rotated text box should be centered on a page of this size. */
function anchorFor(
  position: WatermarkPosition,
  width: number,
  height: number,
  textHeight: number,
): { cx: number; cy: number } {
  if (position === 'bottom') {
    return { cx: width / 2, cy: Math.min(height / 2, 36 + textHeight / 2) };
  }
  return { cx: width / 2, cy: height / 2 };
}

/**
 * Stamp the same text across every page.
 *
 * The text is placed by its own center, so rotating it does not swing it off
 * the page: pdf-lib rotates around the drawing origin, and the origin is
 * offset here to compensate.
 */
export async function watermarkPdf(doc: Uint8Array, options: WatermarkOptions): Promise<Uint8Array> {
  const text = (options?.text ?? '').trim();
  if (text === '') {
    throw new ToolError(
      'empty-watermark',
      'The watermark has no text, so there would be nothing to stamp.',
      'Type the words you want across the pages, such as DRAFT or CONFIDENTIAL.',
    );
  }

  const position = options.position ?? 'diagonal';
  if (!WATERMARK_POSITIONS.includes(position)) {
    throw new ToolError(
      'invalid-position',
      `"${String(position)}" is not a watermark position.`,
      'Choose center, diagonal, or bottom.',
    );
  }

  const opacity = options.opacity ?? 0.2;
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) {
    throw new ToolError(
      'invalid-opacity',
      `An opacity of ${String(options.opacity)} cannot be drawn.`,
      'Use a value above 0 and up to 1. Around 0.2 reads as a watermark without hiding the text under it.',
    );
  }

  const fontSize = options.fontSize ?? 48;
  if (!Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 500) {
    throw new ToolError(
      'invalid-font-size',
      `A font size of ${String(options.fontSize)} cannot be drawn.`,
      'Use a size between 1 and 500 points.',
    );
  }

  const angle = options.angle ?? (position === 'diagonal' ? 45 : 0);
  if (!Number.isFinite(angle)) {
    throw new ToolError(
      'invalid-angle',
      `An angle of ${String(options.angle)} is not a number of degrees.`,
      'Use a number between -180 and 180. 45 is the usual diagonal stamp.',
    );
  }

  const color = parseColor(options.color ?? '#ff0000');

  const source = await loadPdf(doc);
  const font = await source.embedFont(StandardFonts.Helvetica);
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const textHeight = font.heightAtSize(fontSize);
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  for (const page of source.getPages()) {
    const { width, height } = page.getSize();
    const { cx, cy } = anchorFor(position, width, height, textHeight);
    page.drawText(text, {
      x: cx - (textWidth / 2) * cos + (textHeight / 2) * sin,
      y: cy - (textWidth / 2) * sin - (textHeight / 2) * cos,
      size: fontSize,
      font,
      color: rgb(color.r, color.g, color.b),
      opacity,
      rotate: degrees(angle),
    });
  }
  return source.save();
}

/* ------------------------------------------------------------------ */
/* forms                                                               */
/* ------------------------------------------------------------------ */

/** Values a checkbox reads as ticked. Anything else unticks it. */
const TRUTHY = new Set(['true', 'yes', 'on', '1', 'x', 'checked']);

function describeField(field: unknown): FormFieldInfo {
  if (field instanceof PDFTextField) {
    return { name: field.getName(), type: 'text', value: field.getText() ?? '' };
  }
  if (field instanceof PDFCheckBox) {
    return { name: field.getName(), type: 'checkbox', value: String(field.isChecked()) };
  }
  if (field instanceof PDFDropdown) {
    return {
      name: field.getName(),
      type: 'dropdown',
      value: field.getSelected()[0] ?? '',
      options: field.getOptions(),
    };
  }
  if (field instanceof PDFRadioGroup) {
    return {
      name: field.getName(),
      type: 'radio',
      value: field.getSelected() ?? '',
      options: field.getOptions(),
    };
  }
  if (field instanceof PDFOptionList) {
    return {
      name: field.getName(),
      type: 'option list',
      value: field.getSelected().join(', '),
      options: field.getOptions(),
    };
  }
  if (field instanceof PDFButton) {
    return { name: field.getName(), type: 'button' };
  }
  if (field instanceof PDFSignature) {
    return { name: field.getName(), type: 'signature' };
  }
  const named = field as { getName?: () => string };
  return { name: named.getName?.() ?? 'unnamed field', type: 'unknown' };
}

/** Every interactive field in the document, with its current value. */
export async function listFormFields(doc: Uint8Array): Promise<FormFieldInfo[]> {
  const source = await loadPdf(doc);
  return source.getForm().getFields().map(describeField);
}

/** Match a choice case insensitively so typing "red" finds the option "Red". */
function matchOption(value: string, options: string[]): string | undefined {
  const exact = options.find((o) => o === value);
  if (exact !== undefined) return exact;
  const lower = value.toLowerCase();
  return options.find((o) => o.toLowerCase() === lower);
}

function findField(form: PDFForm, name: string) {
  const field = form.getFields().find((f) => f.getName() === name);
  if (!field) {
    const available = form
      .getFields()
      .map((f) => f.getName())
      .join(', ');
    throw new ToolError(
      'unknown-field',
      `This PDF has no form field called "${name}".`,
      available
        ? `The fields in this document are: ${available}.`
        : 'This document has no interactive form fields at all.',
    );
  }
  return field;
}

/**
 * Write values into the form. Text fields take the string as typed, checkboxes
 * read true, yes, on, 1, x, or checked as ticked, and dropdowns, radio groups,
 * and option lists select a matching choice.
 *
 * Flattening bakes the values into the page so nobody can edit them back out,
 * at the cost of the form no longer being fillable.
 */
export async function fillForm(
  doc: Uint8Array,
  values: Record<string, string>,
  options: { flatten?: boolean } = {},
): Promise<Uint8Array> {
  const source = await loadPdf(doc);
  const form = source.getForm();
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) {
    throw new ToolError(
      'no-values',
      'No field values were given, so the form would come back unchanged.',
      'Fill in at least one of the fields listed above, then run it again.',
    );
  }

  for (const [name, raw] of entries) {
    const value = raw ?? '';
    const field = findField(form, name);

    if (field instanceof PDFTextField) {
      field.setText(value);
      continue;
    }
    if (field instanceof PDFCheckBox) {
      if (TRUTHY.has(value.trim().toLowerCase())) field.check();
      else field.uncheck();
      continue;
    }
    if (field instanceof PDFDropdown || field instanceof PDFRadioGroup) {
      if (value.trim() === '') continue;
      const choices = field.getOptions();
      const choice = matchOption(value.trim(), choices);
      if (choice === undefined) {
        throw new ToolError(
          'invalid-option',
          `"${value}" is not one of the choices for the field "${name}".`,
          `Pick one of: ${choices.join(', ')}.`,
        );
      }
      field.select(choice);
      continue;
    }
    if (field instanceof PDFOptionList) {
      if (value.trim() === '') continue;
      const choices = field.getOptions();
      const wanted = value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');
      const resolved: string[] = [];
      for (const one of wanted) {
        const choice = matchOption(one, choices);
        if (choice === undefined) {
          throw new ToolError(
            'invalid-option',
            `"${one}" is not one of the choices for the field "${name}".`,
            `Pick one or more of: ${choices.join(', ')}.`,
          );
        }
        resolved.push(choice);
      }
      field.select(resolved);
      continue;
    }

    throw new ToolError(
      'unsupported-field',
      `The field "${name}" is a ${describeField(field).type} field, which cannot be filled in with text.`,
      'Leave this field alone. Buttons and signature fields need a PDF viewer, not a text value.',
    );
  }

  if (options.flatten) form.flatten();
  return source.save();
}

/* ------------------------------------------------------------------ */
/* info                                                                */
/* ------------------------------------------------------------------ */

/** Common paper sizes in points, so a size readout says something recognizable. */
const PAPER: { name: string; w: number; h: number }[] = [
  { name: 'Letter', w: 612, h: 792 },
  { name: 'Legal', w: 612, h: 1008 },
  { name: 'Tabloid', w: 792, h: 1224 },
  { name: 'A3', w: 841.89, h: 1190.55 },
  { name: 'A4', w: 595.28, h: 841.89 },
  { name: 'A5', w: 419.53, h: 595.28 },
  { name: 'A6', w: 297.64, h: 419.53 },
];

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function paperName(width: number, height: number): string {
  for (const paper of PAPER) {
    const portrait = Math.abs(width - paper.w) < 1.5 && Math.abs(height - paper.h) < 1.5;
    const landscape = Math.abs(width - paper.h) < 1.5 && Math.abs(height - paper.w) < 1.5;
    if (portrait) return paper.name;
    if (landscape) return `${paper.name} landscape`;
  }
  return '';
}

/** Read what is inside the document without changing a byte of it. */
export async function getPdfInfo(doc: Uint8Array): Promise<PdfInfo> {
  const source = await loadPdf(doc);
  const counts = new Map<string, number>();
  for (const page of source.getPages()) {
    const { width, height } = page.getSize();
    const name = paperName(width, height);
    const label = `${round(width)} x ${round(height)} pt${name ? ` (${name})` : ''}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  let formFieldCount: number;
  try {
    formFieldCount = source.getForm().getFields().length;
  } catch {
    // A malformed AcroForm should not stop the rest of the report.
    formFieldCount = 0;
  }

  const info: PdfInfo = {
    pageCount: source.getPageCount(),
    pageSizes: [...counts].map(([label, count]) => ({ label, count })),
    formFieldCount,
    byteLength: doc.length,
  };
  const title = source.getTitle();
  const author = source.getAuthor();
  const subject = source.getSubject();
  const creator = source.getCreator();
  const producer = source.getProducer();
  if (title) info.title = title;
  if (author) info.author = author;
  if (subject) info.subject = subject;
  if (creator) info.creator = creator;
  if (producer) info.producer = producer;
  return info;
}

/* ------------------------------------------------------------------ */
/* generic shell fallback                                              */
/* ------------------------------------------------------------------ */

const USAGE = [
  'PDF Toolbox works on PDF files, not on typed text.',
  '',
  'Drop a .pdf file onto the input, or pick one, and this panel will report',
  'what is inside it. The toolbox on the page can then merge several PDFs,',
  'split or extract page ranges like 1-3,7,9-end, rotate pages by a quarter',
  'turn, reorder or delete pages, stamp a text watermark across every page,',
  'and fill in interactive form fields.',
  '',
  'Everything runs in this tab: your files and inputs never leave your device.',
].join('\n');

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Format a PdfInfo as the plain text rows the generic shell renders. */
export function formatPdfInfo(info: PdfInfo): string {
  const rows: string[] = [
    `Pages: ${info.pageCount}`,
    `File size: ${humanBytes(info.byteLength)}`,
  ];
  for (const size of info.pageSizes) {
    rows.push(`Page size: ${size.label} (${size.count} ${size.count === 1 ? 'page' : 'pages'})`);
  }
  if (info.title) rows.push(`Title: ${info.title}`);
  if (info.author) rows.push(`Author: ${info.author}`);
  if (info.subject) rows.push(`Subject: ${info.subject}`);
  if (info.creator) rows.push(`Creator: ${info.creator}`);
  if (info.producer) rows.push(`Producer: ${info.producer}`);
  rows.push(`Form fields: ${info.formFieldCount}`);
  return rows.join('\n');
}

/**
 * Generic entry point. Bytes are reported on; text gets an explanation of what
 * this tool actually takes, because a PDF cannot be typed in.
 */
export async function run(input: Uint8Array | string): Promise<string> {
  if (typeof input === 'string') return USAGE;
  return formatPdfInfo(await getPdfInfo(input));
}

export default { run } satisfies ToolLogic<Uint8Array | string, string>;
