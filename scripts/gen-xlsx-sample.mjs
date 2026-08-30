// One-off generator for public/samples/sample.xlsx, the worked example behind
// xlsx-viewer's meta.ts. Not part of the build; run it by hand with
// `node scripts/gen-xlsx-sample.mjs` whenever the sample needs regenerating.
//
// An .xlsx is a zip of XML parts, so this writes the parts by hand and zips
// them with fflate. Every entry carries an explicit fixed `mtime`: without one
// fflate stamps Date.now(), and regenerating would produce a fresh diff every
// run. (fflate encodes the DOS timestamp from the local-time getters, so the
// exact bytes still depend on the machine's timezone. That only affects the
// four timestamp bytes per entry, and nothing reads them.)
//
// The sheet contents deliberately exercise the reader: shared strings, a date
// column, a percentage column, a grouped currency column, formulas with cached
// values, a merged header, inline strings, a boolean, and an error cell.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const OUT = fileURLToPath(new URL("../public/samples/sample.xlsx", import.meta.url));

/** Fixed so the archive does not change on every run. */
const MTIME = new Date("2024-01-01T10:00:00Z");

/** Days between 1899-12-30 (the 1900 date system's zero) and 1970-01-01. */
const EPOCH_OFFSET = 25569;

/** An ISO date as the serial number Excel stores for it. */
function serial(iso) {
  return Date.parse(`${iso}T00:00:00Z`) / 86400000 + EPOCH_OFFSET;
}

/** An ISO datetime as a fractional serial number. */
function serialTime(iso) {
  return Date.parse(`${iso}Z`) / 86400000 + EPOCH_OFFSET;
}

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Shared strings
// ---------------------------------------------------------------------------

const shared = [];
/** Intern a string and return its index in the shared string table. */
function s(text) {
  const found = shared.indexOf(text);
  if (found !== -1) return found;
  shared.push(text);
  return shared.length - 1;
}

// ---------------------------------------------------------------------------
// Style indexes, matching the cellXfs order written below
// ---------------------------------------------------------------------------

const STYLE_GENERAL = 0;
const STYLE_DATE = 1; // numFmtId 14, mm-dd-yy
const STYLE_PERCENT = 2; // custom numFmtId 164, 0.0%
const STYLE_MONEY = 3; // numFmtId 4, #,##0.00
const STYLE_DATETIME = 4; // numFmtId 22, m/d/yy h:mm
const STYLE_BOLD = 5; // General, bold font

// ---------------------------------------------------------------------------
// Sheet 1: Orders
// ---------------------------------------------------------------------------

const ORDERS = [
  ["Riverbend Roasters", "2024-03-04", 4, 91.5, 0.05],
  ["Nine Mile Coffee", "2024-03-05", 6, 78.25, 0],
  ["Harborlight Cafe", "2024-03-07", 2, 104, 0.1],
  ["Sunset Provisions", "2024-03-11", 12, 61.75, 0.15],
  ["Cedar Street Bakery", "2024-03-15", 3, 86.4, 0],
  ["Trailhead Outfitters", "2024-03-21", 8, 72.1, 0.05],
  ["Nine Mile Coffee", "2024-03-26", 5, 91.5, 0.025],
  ["Riverbend Roasters", "2024-04-02", 9, 68.3, 0.1],
];

const COLUMN = ["A", "B", "C", "D", "E", "F"];

/** One `<c>` element. */
function cell(ref, { type, value, style = STYLE_GENERAL, formula }) {
  const attrs = [`r="${ref}"`];
  if (style) attrs.push(`s="${style}"`);
  if (type) attrs.push(`t="${type}"`);
  const body = formula
    ? `<f>${esc(formula)}</f><v>${esc(value)}</v>`
    : type === "inlineStr"
      ? `<is><t>${esc(value)}</t></is>`
      : `<v>${esc(value)}</v>`;
  return `<c ${attrs.join(" ")}>${body}</c>`;
}

function sharedCell(ref, text, style = STYLE_GENERAL) {
  return cell(ref, { type: "s", value: s(text), style });
}

const ordersRows = [];

// Row 1: a merged title across the whole table.
ordersRows.push(`<row r="1">${sharedCell("A1", "Quarterly orders", STYLE_BOLD)}</row>`);

// Row 2: the header row.
const headers = ["Customer", "Shipped", "Units", "Unit price", "Discount", "Line total"];
ordersRows.push(
  `<row r="2">${headers
    .map((text, i) => sharedCell(`${COLUMN[i]}2`, text, STYLE_BOLD))
    .join("")}</row>`,
);

// Rows 3 and down: the data, with a formula in column F.
ORDERS.forEach(([customer, date, units, price, discount], i) => {
  const r = i + 3;
  const total = units * price * (1 - discount);
  ordersRows.push(
    `<row r="${r}">` +
      sharedCell(`A${r}`, customer) +
      cell(`B${r}`, { value: serial(date), style: STYLE_DATE }) +
      cell(`C${r}`, { value: units }) +
      cell(`D${r}`, { value: price, style: STYLE_MONEY }) +
      cell(`E${r}`, { value: discount, style: STYLE_PERCENT }) +
      cell(`F${r}`, {
        value: Math.round(total * 100) / 100,
        style: STYLE_MONEY,
        formula: `C${r}*D${r}*(1-E${r})`,
      }) +
      `</row>`,
  );
});

// A totals row, one row below the data with a gap, so sparse rows are covered.
const lastData = ORDERS.length + 2;
const grandTotal =
  Math.round(
    ORDERS.reduce((sum, [, , units, price, discount]) => sum + units * price * (1 - discount), 0) *
      100,
  ) / 100;
ordersRows.push(
  `<row r="${lastData + 2}">` +
    sharedCell(`E${lastData + 2}`, "Total", STYLE_BOLD) +
    cell(`F${lastData + 2}`, {
      value: grandTotal,
      style: STYLE_MONEY,
      formula: `SUM(F3:F${lastData})`,
    }) +
    `</row>`,
);

const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:F${lastData + 2}"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="6" width="13" customWidth="1"/></cols>
<sheetData>${ordersRows.join("")}</sheetData>
<mergeCells count="1"><mergeCell ref="A1:F1"/></mergeCells>
</worksheet>`;

// ---------------------------------------------------------------------------
// Sheet 2: Notes, exercising the cell types the orders sheet does not
// ---------------------------------------------------------------------------

const notesRows = [
  `<row r="1">` +
    cell("A1", { type: "inlineStr", value: "Field", style: STYLE_BOLD }) +
    cell("B1", { type: "inlineStr", value: "Value", style: STYLE_BOLD }) +
    `</row>`,
  `<row r="2">` +
    cell("A2", { type: "inlineStr", value: "Exported at" }) +
    cell("B2", { value: serialTime("2024-04-03T09:30:00"), style: STYLE_DATETIME }) +
    `</row>`,
  `<row r="3">` +
    cell("A3", { type: "inlineStr", value: "Includes tax" }) +
    cell("B3", { type: "b", value: 0 }) +
    `</row>`,
  `<row r="4">` +
    cell("A4", { type: "inlineStr", value: "Lookup that failed" }) +
    cell("B4", { type: "e", value: "#N/A" }) +
    `</row>`,
  `<row r="5">` +
    cell("A5", { type: "inlineStr", value: "Note" }) +
    cell("B5", { type: "inlineStr", value: 'Prices are per kilo, "green" weight.' }) +
    `</row>`,
];

const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:B5"/>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="22" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/></cols>
<sheetData>${notesRows.join("")}</sheetData>
</worksheet>`;

// ---------------------------------------------------------------------------
// The remaining parts
// ---------------------------------------------------------------------------

const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
  .map((text) => `<si><t xml:space="preserve">${esc(text)}</t></si>`)
  .join("")}</sst>`;

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr date1904="0"/>
<sheets><sheet name="Orders" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets>
</workbook>`;

const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

// ---------------------------------------------------------------------------
// Zip it
// ---------------------------------------------------------------------------

const parts = {
  "[Content_Types].xml": contentTypes,
  "_rels/.rels": rootRels,
  "xl/workbook.xml": workbook,
  "xl/_rels/workbook.xml.rels": workbookRels,
  "xl/sharedStrings.xml": sharedStrings,
  "xl/styles.xml": styles,
  "xl/worksheets/sheet1.xml": sheet1,
  "xl/worksheets/sheet2.xml": sheet2,
};

const zippable = {};
for (const [path, xml] of Object.entries(parts)) {
  zippable[path] = [strToU8(xml), { level: 9, mtime: MTIME }];
}

const bytes = zipSync(zippable, { level: 9, mtime: MTIME });
writeFileSync(OUT, bytes);
console.log(`wrote ${OUT} (${bytes.length} bytes, ${Object.keys(parts).length} parts)`);
