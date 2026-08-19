import { formatByteCount } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * WebAssembly module inspector.
 *
 * A hand-rolled binary parser: no dependencies, no DOM, no network. It walks the
 * section table of a .wasm module and reports the structure (types, imports,
 * exports, functions, memories, start function) plus the post-MVP proposals it
 * can see. Only proposals with a definitive structural signal (a shared memory
 * limit, a tag section, a v128 or externref in a function signature, a DataCount
 * section) are reported. Nothing is guessed from raw code bytes, so the feature
 * list never overclaims.
 *
 * `TextDecoder` and `atob` are platform primitives present in both Node and the
 * browser, so they are fair game the same way `crypto` is.
 */

/* ------------------------------------------------------------------ */
/* options                                                            */
/* ------------------------------------------------------------------ */

export interface WasmOpts {
  /** "summary" | "sections" | "symbols". */
  view: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* LEB128                                                             */
/* ------------------------------------------------------------------ */

export interface LebResult {
  value: number;
  /** Offset of the first byte after the encoded number. */
  next: number;
}

/**
 * Unsigned LEB128. Uses multiplication rather than `<<` so values above 2^31
 * stay correct instead of wrapping into a negative int32.
 */
export function readUleb128(bytes: Uint8Array, offset: number, what = "number"): LebResult {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw truncated(what);
    const byte = bytes[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: pos };
    shift += 7;
  }
  throw new ToolError(
    "bad-leb128",
    `A LEB128 ${what} in this module never terminates.`,
    "The file is probably corrupt. Re-export or re-download the module.",
  );
}

/** Signed LEB128, used for value type indices and constant expressions. */
export function readSleb128(bytes: Uint8Array, offset: number, what = "number"): LebResult {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw truncated(what);
    const byte = bytes[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      if (byte & 0x40) value -= 2 ** shift;
      return { value, next: pos };
    }
  }
  throw new ToolError(
    "bad-leb128",
    `A signed LEB128 ${what} in this module never terminates.`,
    "The file is probably corrupt. Re-export or re-download the module.",
  );
}

function truncated(what: string): ToolError {
  return new ToolError(
    "truncated",
    `This module ends in the middle of the ${what}.`,
    "The file looks cut off. Check the download or export completed.",
  );
}

/* ------------------------------------------------------------------ */
/* cursor                                                             */
/* ------------------------------------------------------------------ */

class Cursor {
  readonly bytes: Uint8Array;
  pos: number;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  u8(what: string): number {
    if (this.pos >= this.bytes.length) throw truncated(what);
    return this.bytes[this.pos++];
  }

  take(n: number, what: string): Uint8Array {
    if (this.pos + n > this.bytes.length) throw truncated(what);
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  u32le(what: string): number {
    const b = this.take(4, what);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  uleb(what: string): number {
    const r = readUleb128(this.bytes, this.pos, what);
    this.pos = r.next;
    return r.value;
  }

  /** A wasm name: a byte vector holding UTF-8. */
  name(what: string): string {
    const len = this.uleb(`${what} length`);
    return new TextDecoder("utf-8").decode(this.take(len, what));
  }
}

/* ------------------------------------------------------------------ */
/* input decoding                                                     */
/* ------------------------------------------------------------------ */

const MAGIC = [0x00, 0x61, 0x73, 0x6d]; // "\0asm"

function hasMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && MAGIC.every((b, i) => bytes[i] === b);
}

function emptyInput(): ToolError {
  return new ToolError("empty-input", "Provide a .wasm module.", "Drop a .wasm file.");
}

function notWasm(): ToolError {
  return new ToolError(
    "not-wasm",
    "This does not look like a WebAssembly module.",
    "Drop a .wasm file or paste its base64.",
  );
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array | null {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  if (normal.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normal)) return null;
  try {
    const binary = atob(normal);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Accept raw bytes, a "0x.." hex dump, a bare hex or base64 string, or a
 * `data:application/wasm;base64,` URL.
 *
 * Hex and base64 share an alphabet, so a hex dump such as `0061736d...` is also
 * a syntactically valid base64 string that decodes to garbage. Rather than
 * guessing by shape, both decodings are attempted and the one that produces the
 * wasm magic bytes wins.
 */
function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input !== "string") {
    if (!input || input.length === 0) throw emptyInput();
    return input;
  }

  const trimmed = input.trim();
  if (trimmed === "") throw emptyInput();

  let payload = trimmed;
  const dataUrl = /^data:[^,]*,/.exec(trimmed);
  if (dataUrl) {
    if (!/;base64/i.test(dataUrl[0])) throw notWasm();
    payload = trimmed.slice(dataUrl[0].length);
  }

  const compact = payload.replace(/\s+/g, "");
  if (compact === "") throw emptyInput();

  if (/^0[xX]/.test(compact)) {
    const bytes = hexToBytes(compact.slice(2));
    if (!bytes || !hasMagic(bytes)) throw notWasm();
    return bytes;
  }

  const candidates = [hexToBytes(compact), base64ToBytes(compact)];
  for (const bytes of candidates) {
    if (bytes && hasMagic(bytes)) return bytes;
  }
  throw notWasm();
}

/* ------------------------------------------------------------------ */
/* module model                                                       */
/* ------------------------------------------------------------------ */

const SECTION_NAMES: Record<number, string> = {
  0: "custom",
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "data count",
  13: "tag",
};

const EXTERNAL_KINDS: Record<number, string> = {
  0: "func",
  1: "table",
  2: "memory",
  3: "global",
  4: "tag",
};

export interface WasmSection {
  id: number;
  /** "type", "custom", or "unknown (id 42)". */
  label: string;
  /** Body length in bytes, as declared by the section header. */
  size: number;
  /** Offset of the section id byte inside the module. */
  offset: number;
  /** Offset of the first body byte inside the module. */
  bodyOffset: number;
  /** Name of a custom section, when it could be read. */
  customName?: string;
}

export interface WasmLimits {
  min: number;
  max?: number;
  shared: boolean;
  index64: boolean;
}

export interface WasmMemory extends WasmLimits {
  /** Set when the memory comes in through the import section. */
  importedAs?: string;
}

export interface WasmImport {
  module: string;
  name: string;
  kind: string;
  detail?: string;
}

export interface WasmExport {
  name: string;
  kind: string;
  index: number;
}

export interface WasmModule {
  version: number;
  size: number;
  sections: WasmSection[];
  typeCount: number;
  imports: WasmImport[];
  exports: WasmExport[];
  functionCount: number;
  tableCount: number;
  memories: WasmMemory[];
  globalCount: number;
  elementCount: number;
  dataCount: number;
  codeCount: number;
  tagCount: number;
  start?: number;
  hasDataCountSection: boolean;
  /** A function signature returns more than one value. */
  multiValue: boolean;
  /** A function signature mentions v128. */
  vectorInSignature: boolean;
  /** A function signature mentions externref. */
  externrefInSignature: boolean;
}

/* ------------------------------------------------------------------ */
/* section parsers                                                    */
/* ------------------------------------------------------------------ */

function readLimits(c: Cursor, what: string): WasmLimits {
  const flag = c.u8(`${what} limits flag`);
  const min = c.uleb(`${what} minimum`);
  const max = (flag & 0x01) !== 0 ? c.uleb(`${what} maximum`) : undefined;
  return { min, max, shared: (flag & 0x02) !== 0, index64: (flag & 0x04) !== 0 };
}

const VALTYPE_NAMES: Record<number, string> = {
  0x7f: "i32",
  0x7e: "i64",
  0x7d: "f32",
  0x7c: "f64",
  0x7b: "v128",
  0x70: "funcref",
  0x6f: "externref",
};

interface TypeFindings {
  count: number;
  multiValue: boolean;
  vector: boolean;
  externref: boolean;
}

function parseTypeSection(body: Uint8Array): TypeFindings {
  const c = new Cursor(body);
  const out: TypeFindings = { count: 0, multiValue: false, vector: false, externref: false };
  out.count = c.uleb("type count");

  for (let i = 0; i < out.count; i++) {
    const form = c.u8("type form");
    // 0x60 is a plain function type. The GC proposal wraps types in rec/sub
    // groups with other leading bytes; the count is still right, so stop the
    // deep walk rather than misreading the rest.
    if (form !== 0x60) return out;
    const params = c.uleb("parameter count");
    for (let p = 0; p < params; p++) noteValtype(c.u8("parameter type"), out);
    const results = c.uleb("result count");
    if (results > 1) out.multiValue = true;
    for (let rIdx = 0; rIdx < results; rIdx++) noteValtype(c.u8("result type"), out);
  }
  return out;
}

function noteValtype(byte: number, out: TypeFindings): void {
  if (byte === 0x7b) out.vector = true;
  if (byte === 0x6f) out.externref = true;
}

function parseImportSection(body: Uint8Array): { imports: WasmImport[]; memories: WasmMemory[] } {
  const c = new Cursor(body);
  const count = c.uleb("import count");
  const imports: WasmImport[] = [];
  const memories: WasmMemory[] = [];

  for (let i = 0; i < count; i++) {
    const module = c.name("import module name");
    const name = c.name("import field name");
    const kindByte = c.u8("import kind");
    const kind = EXTERNAL_KINDS[kindByte] ?? `unknown kind ${kindByte}`;
    let detail: string | undefined;

    switch (kindByte) {
      case 0x00:
        detail = `type ${c.uleb("import type index")}`;
        break;
      case 0x01: {
        const ref = c.u8("imported table element type");
        const limits = readLimits(c, "imported table");
        detail = `${VALTYPE_NAMES[ref] ?? `type 0x${ref.toString(16)}`}, ${describeLimits(limits, "entry", "entries")}`;
        break;
      }
      case 0x02: {
        const limits = readLimits(c, "imported memory");
        memories.push({ ...limits, importedAs: `${module}.${name}` });
        detail = describeLimits(limits, "page", "pages");
        break;
      }
      case 0x03: {
        const valtype = c.u8("imported global type");
        const mutable = c.u8("imported global mutability") === 0x01;
        detail = `${VALTYPE_NAMES[valtype] ?? `type 0x${valtype.toString(16)}`}${mutable ? ", mutable" : ""}`;
        break;
      }
      case 0x04:
        c.u8("imported tag attribute");
        detail = `type ${c.uleb("imported tag type index")}`;
        break;
      default:
        // An import kind this parser does not know: the rest of the section
        // cannot be walked safely, so keep what was read and stop.
        imports.push({ module, name, kind });
        return { imports, memories };
    }

    imports.push({ module, name, kind, detail });
  }

  return { imports, memories };
}

function parseExportSection(body: Uint8Array): WasmExport[] {
  const c = new Cursor(body);
  const count = c.uleb("export count");
  const exports: WasmExport[] = [];
  for (let i = 0; i < count; i++) {
    const name = c.name("export name");
    const kindByte = c.u8("export kind");
    const index = c.uleb("export index");
    exports.push({ name, kind: EXTERNAL_KINDS[kindByte] ?? `unknown kind ${kindByte}`, index });
  }
  return exports;
}

function parseMemorySection(body: Uint8Array): WasmMemory[] {
  const c = new Cursor(body);
  const count = c.uleb("memory count");
  const memories: WasmMemory[] = [];
  for (let i = 0; i < count; i++) memories.push(readLimits(c, "memory"));
  return memories;
}

/* ------------------------------------------------------------------ */
/* module parser                                                      */
/* ------------------------------------------------------------------ */

export function parseWasm(bytes: Uint8Array): WasmModule {
  if (!hasMagic(bytes)) throw notWasm();
  if (bytes.length < 8) throw truncated("module header");

  const header = new Cursor(bytes, 4);
  const version = header.u32le("module version");
  if (version !== 1) {
    throw new ToolError(
      "unsupported-version",
      `This file declares WebAssembly version ${version}, not version 1.`,
      "Only version 1 core modules are supported. A component model binary uses a different version and cannot be read here.",
    );
  }

  const mod: WasmModule = {
    version,
    size: bytes.length,
    sections: [],
    typeCount: 0,
    imports: [],
    exports: [],
    functionCount: 0,
    tableCount: 0,
    memories: [],
    globalCount: 0,
    elementCount: 0,
    dataCount: 0,
    codeCount: 0,
    tagCount: 0,
    hasDataCountSection: false,
    multiValue: false,
    vectorInSignature: false,
    externrefInSignature: false,
  };

  const walker = new Cursor(bytes, 8);
  while (walker.remaining > 0) {
    const offset = walker.pos;
    const id = walker.u8("section id");
    const size = walker.uleb("section size");
    const bodyOffset = walker.pos;
    if (bodyOffset + size > bytes.length) {
      throw truncated(`${SECTION_NAMES[id] ?? `unknown (id ${id})`} section`);
    }
    const body = bytes.subarray(bodyOffset, bodyOffset + size);
    walker.pos = bodyOffset + size;

    const section: WasmSection = {
      id,
      label: SECTION_NAMES[id] ?? `unknown (id ${id})`,
      size,
      offset,
      bodyOffset,
    };
    mod.sections.push(section);

    // Section bodies are parsed best effort: a structural problem in one
    // section should degrade that row, not blow up the whole report. Anything
    // that breaks the section table itself already threw above.
    try {
      readSectionBody(id, body, section, mod);
    } catch {
      /* leave the counts this parser could not read at their defaults */
    }
  }

  return mod;
}

function readSectionBody(
  id: number,
  body: Uint8Array,
  section: WasmSection,
  mod: WasmModule,
): void {
  switch (id) {
    case 0:
      section.customName = new Cursor(body).name("custom section name");
      break;
    case 1: {
      const found = parseTypeSection(body);
      mod.typeCount = found.count;
      mod.multiValue = mod.multiValue || found.multiValue;
      mod.vectorInSignature = mod.vectorInSignature || found.vector;
      mod.externrefInSignature = mod.externrefInSignature || found.externref;
      break;
    }
    case 2: {
      const found = parseImportSection(body);
      mod.imports = found.imports;
      mod.memories.push(...found.memories);
      break;
    }
    case 3:
      mod.functionCount = new Cursor(body).uleb("function count");
      break;
    case 4:
      mod.tableCount = new Cursor(body).uleb("table count");
      break;
    case 5:
      mod.memories.push(...parseMemorySection(body));
      break;
    case 6:
      mod.globalCount = new Cursor(body).uleb("global count");
      break;
    case 7:
      mod.exports = parseExportSection(body);
      break;
    case 8:
      mod.start = new Cursor(body).uleb("start function index");
      break;
    case 9:
      mod.elementCount = new Cursor(body).uleb("element segment count");
      break;
    case 10:
      mod.codeCount = new Cursor(body).uleb("code entry count");
      break;
    case 11:
      mod.dataCount = new Cursor(body).uleb("data segment count");
      break;
    case 12:
      mod.hasDataCountSection = true;
      mod.dataCount = new Cursor(body).uleb("data count");
      break;
    case 13:
      mod.tagCount = new Cursor(body).uleb("tag count");
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* feature detection                                                  */
/* ------------------------------------------------------------------ */

/**
 * Features are only reported when there is evidence for them. A feature that
 * cannot be seen is simply absent from the list, never reported as "no".
 */
export function detectFeatures(mod: WasmModule): string[] {
  const features: string[] = [];
  const importedTag = mod.imports.some((i) => i.kind === "tag");

  if (mod.memories.some((m) => m.shared)) features.push("Threads / shared memory");
  if (mod.memories.length > 1) features.push("Multiple memories");
  if (mod.memories.some((m) => m.index64)) features.push("Memory64");
  if (mod.hasDataCountSection) features.push("Bulk memory");
  if (mod.multiValue) features.push("Multi-value");

  // Only definitive, structural signals are reported. A raw byte scan of the
  // code section was tried and removed: the opcode bytes for SIMD, reference
  // types, tail calls, and exceptions all collide with ordinary LEB128
  // immediates, so it fired on almost every real module. False "(heuristic)"
  // features are worse than an honest absence.
  if (mod.vectorInSignature) features.push("SIMD");
  if (mod.tagCount > 0 || importedTag) features.push("Exception handling");
  if (mod.externrefInSignature) features.push("Reference types");

  return features;
}

/* ------------------------------------------------------------------ */
/* rendering                                                          */
/* ------------------------------------------------------------------ */

const SAMPLE_CAP = 6;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describeLimits(limits: WasmLimits, one: string, many: string): string {
  const parts = [`initial ${plural(limits.min, one, many)}`];
  parts.push(limits.max === undefined ? "no maximum" : `max ${plural(limits.max, one, many)}`);
  parts.push(limits.shared ? "shared" : "not shared");
  return parts.join(", ");
}

function describeMemories(memories: WasmMemory[]): string {
  if (memories.length === 0) return "none";
  const rows = memories.map((m, i) => {
    const label = m.importedAs ? `${m.importedAs} (imported)` : `#${i}`;
    return `${label}: ${describeLimits(m, "page", "pages")}`;
  });
  return rows.join("; ");
}

function summarise(items: string[], count: number): string {
  if (count === 0) return "none";
  const shown = items.slice(0, SAMPLE_CAP);
  const suffix = count > shown.length ? ", ..." : "";
  return `${count}: ${shown.join(", ")}${suffix}`;
}

function sectionList(mod: WasmModule): string {
  if (mod.sections.length === 0) return "none";
  return mod.sections
    .map((s) => {
      const name = s.customName ? `${s.label} "${s.customName}"` : s.label;
      return `${name} (${formatByteCount(s.size)})`;
    })
    .join(", ");
}

function importLabel(i: WasmImport): string {
  return `${i.module}.${i.name} (${i.kind})`;
}

function exportLabel(e: WasmExport): string {
  return `${e.name} (${e.kind} ${e.index})`;
}

function summaryView(mod: WasmModule): Record<string, string> {
  const features = detectFeatures(mod);
  return {
    Version: String(mod.version),
    Size: formatByteCount(mod.size),
    Sections: sectionList(mod),
    Types: String(mod.typeCount),
    Imports: summarise(mod.imports.map(importLabel), mod.imports.length),
    Exports: summarise(mod.exports.map(exportLabel), mod.exports.length),
    Functions: String(mod.functionCount),
    Tables: String(mod.tableCount),
    Memory: describeMemories(mod.memories),
    Globals: String(mod.globalCount),
    "Element segments": String(mod.elementCount),
    "Data segments": String(mod.dataCount),
    Start: mod.start === undefined ? "none" : `function ${mod.start}`,
    "Features detected": features.length === 0 ? "MVP only" : features.join(", "),
  };
}

function sectionsView(mod: WasmModule): Record<string, string> {
  const out: Record<string, string> = {
    Module: `version ${mod.version}, ${formatByteCount(mod.size)}`,
  };
  if (mod.sections.length === 0) {
    out.Sections = "none";
    return out;
  }
  mod.sections.forEach((s, i) => {
    const name = s.customName ? `${s.label} "${s.customName}"` : s.label;
    // Two custom sections can share a name, so the index keeps the keys unique.
    out[`#${i + 1} ${name}`] =
      `id ${s.id}, ${formatByteCount(s.size)}, body at offset ${s.bodyOffset}`;
  });
  return out;
}

function symbolsView(mod: WasmModule): Record<string, string> {
  const out: Record<string, string> = {
    Imports: mod.imports.length === 0 ? "none" : String(mod.imports.length),
    Exports: mod.exports.length === 0 ? "none" : String(mod.exports.length),
  };
  // Two imports can share module.name across kinds, so index the keys.
  mod.imports.forEach((i, n) => {
    out[`Import #${n + 1}`] = i.detail ? `${importLabel(i)}, ${i.detail}` : importLabel(i);
  });
  mod.exports.forEach((e, n) => {
    out[`Export #${n + 1}`] = exportLabel(e);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* entry point                                                        */
/* ------------------------------------------------------------------ */

export function run(input: Uint8Array | string, opts: WasmOpts): Record<string, string> {
  const mod = parseWasm(toBytes(input));
  switch (opts?.view) {
    case "sections":
      return sectionsView(mod);
    case "symbols":
      return symbolsView(mod);
    default:
      return summaryView(mod);
  }
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, WasmOpts>;
