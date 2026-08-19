import { ToolError, type ToolLogic } from "../types";

/**
 * WebAssembly feature detection, the classic wasm-feature-detect technique:
 * for every post-MVP proposal that leaves a structural fingerprint, hand
 * assemble the smallest possible `.wasm` module that only parses if the
 * engine implements that proposal, and let the browser's own
 * `WebAssembly.validate()` answer yes or no. The panel owns `validate()` (it
 * is a browser API, not something this pure module may call); this file only
 * builds the probe bytes and formats whatever booleans come back.
 *
 * Three proposals cannot be detected this way at all and are therefore not
 * in `FEATURE_PROBES`: JS Promise Integration and js-string-builtins only
 * change how imports/exports interact with JS, not module validity, and
 * type reflection only changes what the JS API exposes about a compiled
 * module. All three are called out in the page copy instead of probed.
 *
 * A tiny internal assembler (`leb128u` / `vec` / `section` / `mod`) builds
 * the module bytes. This keeps section length prefixes, which are the
 * easiest part of hand rolled wasm to get wrong by one byte, mechanically
 * correct while every opcode, section id, and type encoding below is still
 * written by hand from the spec. Every probe was verified with Node 22's own
 * `WebAssembly.validate()` while authoring this file (see index.test.ts).
 */

/* ------------------------------------------------------------------ */
/* tiny binary assembler                                              */
/* ------------------------------------------------------------------ */

function leb128u(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function vec(items: number[][]): number[] {
  return [...leb128u(items.length), ...items.flat()];
}

function section(id: number, body: number[]): number[] {
  return [id, ...leb128u(body.length), ...body];
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d]; // "\0asm"
const VERSION = [0x01, 0x00, 0x00, 0x00];

function mod(...sections: number[][]): Uint8Array {
  return new Uint8Array([...MAGIC, ...VERSION, ...sections.flat()]);
}

/** A function type with no parameters and no results: `() -> ()`. */
const FUNC_VOID_TYPE = [0x60, 0x00, 0x00];

function typeSection(...types: number[][]): number[] {
  return section(1, vec(types));
}

function functionSection(...typeIndices: number[]): number[] {
  return section(3, vec(typeIndices.map((i) => leb128u(i))));
}

function codeSection(...bodies: number[][]): number[] {
  return section(10, vec(bodies.map((b) => [...leb128u(b.length), ...b])));
}

/** A function body: local decl vector (empty here), the instructions, then `end` (0x0b). */
function fnBody(instrs: number[]): number[] {
  return [0x00, ...instrs, 0x0b];
}

/** `v128.const` (0xfd 0x0c) with a 16 byte all zero immediate. */
function v128Const(): number[] {
  return [0xfd, 0x0c, ...new Array(16).fill(0)];
}

/* ------------------------------------------------------------------ */
/* probes                                                             */
/* ------------------------------------------------------------------ */

export interface FeatureProbe {
  /** Short id, matching the WebAssembly proposals repo slug where one exists. */
  id: string;
  /** Human readable name shown as the row label. */
  label: string;
  /** The proposal's canonical name, shown alongside the yes/no verdict. */
  proposal: string;
  /** Rough note on when major engines picked this up. Not exact version pinning. */
  since: string;
  /** The smallest module that only parses if the engine implements this proposal. */
  bytes: Uint8Array;
}

export const FEATURE_PROBES: FeatureProbe[] = [
  {
    id: "bulk-memory",
    label: "Bulk memory operations",
    proposal: "bulk-memory-operations",
    since: "Landed across Chrome, Firefox and Safari between 2019 and 2021.",
    // memory.fill (0xfc 0x0b) over a declared memory.
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      section(5, vec([[0x00, 0x01]])), // one memory, flag 0 (no max), min 1
      codeSection(fnBody([0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00])),
    ),
  },
  {
    id: "exceptions",
    label: "Exception handling (legacy try/catch)",
    proposal: "exception-handling (legacy)",
    since: "Shipped in V8 (Chrome, Node) from 2021. Being superseded by the exnref design below.",
    // A tag section plus a function using legacy try (0x06) / catch (0x07).
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      section(13, vec([[0x00, 0x00]])), // tag: attribute 0, type index 0
      codeSection(fnBody([0x06, 0x40, 0x07, 0x00, 0x0b])),
    ),
  },
  {
    id: "exnref",
    label: "Exception handling (new design, try_table/exnref)",
    proposal: "exception-handling (exnref)",
    since: "The reworked exception handling design finalized in 2023, shipping in Chrome and Firefox since 2024.",
    // try_table (0x1f) with a single catch_all clause branching to label 0.
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      codeSection(fnBody([0x1f, 0x40, 0x01, 0x02, 0x00, 0x0b])),
    ),
  },
  {
    id: "extended-const",
    label: "Extended constant expressions",
    proposal: "extended-const",
    since: "Shipped in Chrome and Firefox during 2023.",
    // A global initializer that does arithmetic (i32.add of two consts)
    // instead of a single const or global.get.
    bytes: mod(section(6, vec([[0x7f, 0x00, 0x41, 0x01, 0x41, 0x02, 0x6a, 0x0b]]))),
  },
  {
    id: "gc",
    label: "Garbage collected types (structs and arrays)",
    proposal: "gc",
    since: "Shipped in Chrome and Firefox in late 2023; Safari followed in 2024 to 2025.",
    // A struct type (0x5f) with zero fields in the type section.
    bytes: mod(typeSection([0x5f, 0x00])),
  },
  {
    id: "memory64",
    label: "64 bit memory addressing",
    proposal: "memory64",
    since: "Shipped in V8 (Chrome, Node) from 2024; still catching up in other engines.",
    // Memory limits flag 0x04: 64 bit index, no maximum, min 1 page.
    bytes: mod(section(5, vec([[0x04, 0x01]]))),
  },
  {
    id: "multi-memory",
    label: "Multiple memories per module",
    proposal: "multi-memory",
    since: "Shipped in Chrome from 2022 and Firefox from 2023.",
    // Two memory entries in one memory section (MVP core wasm allows only one).
    bytes: mod(
      section(
        5,
        vec([
          [0x00, 0x01],
          [0x00, 0x01],
        ]),
      ),
    ),
  },
  {
    id: "multi-value",
    label: "Multiple return values",
    proposal: "multi-value",
    since: "Landed across Chrome, Firefox and Safari between 2019 and 2022.",
    // A function type with two results, which the original MVP forbids.
    bytes: mod(typeSection([0x60, 0x00, 0x02, 0x7f, 0x7f])),
  },
  {
    id: "mutable-globals",
    label: "Mutable global import and export",
    proposal: "mutable-global",
    since: "One of the earliest post MVP features, shipped across all major engines by 2019.",
    // A mutable i32 global that is also exported (the MVP only allowed
    // exporting immutable globals).
    bytes: mod(
      section(6, vec([[0x7f, 0x01, 0x41, 0x00, 0x0b]])), // global: i32, mutable, init 0
      section(7, vec([[0x01, 0x67, 0x03, 0x00]])), // export "g" -> global 0
    ),
  },
  {
    id: "reference-types",
    label: "Reference types (externref, table.get/set)",
    proposal: "reference-types",
    since: "Shipped across Chrome, Firefox and Safari between 2021 and 2022.",
    // A table of externref (0x6f), the MVP only allows funcref tables, read
    // through table.get (0x25).
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      section(4, vec([[0x6f, 0x00, 0x00]])), // table: externref, flag 0, min 0
      codeSection(fnBody([0x41, 0x00, 0x25, 0x00, 0x1a])),
    ),
  },
  {
    id: "relaxed-simd",
    label: "Relaxed SIMD",
    proposal: "relaxed-simd",
    since: "Shipped in Chrome from 2023; Firefox and Safari support is still catching up.",
    // i8x16.relaxed_swizzle: prefix 0xfd, extended opcode 0x100 (LEB encoded).
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      codeSection(
        fnBody([...v128Const(), ...v128Const(), 0xfd, ...leb128u(0x100), 0x1a]),
      ),
    ),
  },
  {
    id: "saturated-float-to-int",
    label: "Non trapping float to int conversions",
    proposal: "nontrapping-float-to-int-conversions",
    since: "Part of the original post MVP wave, widely supported between 2019 and 2021.",
    // i32.trunc_sat_f32_s: prefix 0xfc, sub opcode 0x00.
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      codeSection(fnBody([0x43, 0x00, 0x00, 0x00, 0x00, 0xfc, 0x00, 0x1a])),
    ),
  },
  {
    id: "sign-extension",
    label: "Sign extension operators",
    proposal: "sign-extension-ops",
    since: "Part of the original post MVP wave, widely supported between 2018 and 2021.",
    // i32.extend8_s (0xc0).
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      codeSection(fnBody([0x41, 0x00, 0xc0, 0x1a])),
    ),
  },
  {
    id: "simd",
    label: "Fixed width 128 bit SIMD",
    proposal: "simd",
    since: "Shipped in Chrome and Firefox from 2021; Safari added support in 2023.",
    // v128.const (0xfd 0x0c).
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      codeSection(fnBody([...v128Const(), 0x1a])),
    ),
  },
  {
    id: "tail-call",
    label: "Tail calls (return_call)",
    proposal: "tail-call",
    since: "Shipped in Chrome and Firefox during 2023; Safari support is still rolling out.",
    // return_call (0x12) to the function's own index: a valid, self
    // referential tail call.
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      codeSection(fnBody([0x12, 0x00])),
    ),
  },
  {
    id: "threads",
    label: "Threads and atomics (shared memory)",
    proposal: "threads",
    since: "Shipped in Chrome and Firefox from 2020, Safari from 2023. Needs a cross origin isolated page (COOP/COEP) at runtime even when the engine supports it.",
    // Shared memory (limits flag 0x03: has max, shared) plus i32.atomic.load
    // (prefix 0xfe, sub opcode 0x10).
    bytes: mod(
      typeSection(FUNC_VOID_TYPE),
      functionSection(0),
      section(5, vec([[0x03, 0x01, 0x01]])), // shared memory, min 1, max 1
      codeSection(fnBody([0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a])),
    ),
  },
];

/** id -> probe, for fast lookup while formatting. */
const PROBES_BY_ID: Record<string, FeatureProbe> = Object.fromEntries(
  FEATURE_PROBES.map((p) => [p.id, p]),
);

/**
 * The 2023 "Wasm 2.0" baseline feature set. "Non trapping float to int
 * conversions" is the official name of the proposal this file calls
 * `saturated-float-to-int`, so the baseline check below is seven ids
 * covering all eight names commonly used for the set.
 */
const BASELINE_IDS = [
  "bulk-memory",
  "multi-value",
  "mutable-globals",
  "reference-types",
  "saturated-float-to-int",
  "sign-extension",
  "simd",
];

/* ------------------------------------------------------------------ */
/* formatting                                                         */
/* ------------------------------------------------------------------ */

/**
 * Turns a map of feature id to supported/not supported (produced by the
 * panel running `WebAssembly.validate()` over every `FEATURE_PROBES` entry)
 * into labeled rows, in `FEATURE_PROBES` order. Ids not present in `results`
 * are left out (nothing was tested for them); unrecognized ids in `results`
 * are ignored, since only known probes have a label and proposal name to
 * show.
 */
export function describeSupport(results: Record<string, boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  let supportedCount = 0;

  for (const probe of FEATURE_PROBES) {
    if (!(probe.id in results)) continue;
    const supported = results[probe.id] === true;
    if (supported) supportedCount++;
    out[probe.label] = `${supported ? "Supported" : "Not supported"} (${probe.proposal})`;
  }

  out["Summary"] = `${supportedCount} of ${FEATURE_PROBES.length} features supported`;

  const hasBaseline = BASELINE_IDS.every((id) => results[id] === true);
  out["Baseline"] = `Wasm 2.0 baseline: ${hasBaseline ? "yes" : "no"}`;

  return out;
}

/** The probe catalog as rows, shown before the panel has run any checks. */
function probeCatalog(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const probe of FEATURE_PROBES) {
    out[probe.label] = `${probe.proposal}, ${probe.since}`;
  }
  out["Note"] =
    "This panel runs WebAssembly.validate() over a tiny module per feature in your browser to fill in this list. JS Promise Integration, js-string-builtins, and type reflection cannot be detected this way, since they change JS interop rather than module validity.";
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface WasmFeatureDetectorOpts {
  [key: string]: unknown;
}

/**
 * `input` is a JSON string `{ featureId: boolean }` the panel produces by
 * running `WebAssembly.validate()` over every `FEATURE_PROBES` entry. Empty
 * input (nothing run yet) returns the probe catalog instead, so the generic
 * shell always has something useful to show.
 */
export function run(
  input: string,
  _opts: WasmFeatureDetectorOpts = {},
): Record<string, string> {
  if (!input.trim()) return probeCatalog();

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new ToolError(
      "bad-json",
      "The input is not valid JSON.",
      "This panel builds its input automatically; paste a {\"featureId\": true} style report if entering one by hand.",
    );
  }

  if (!isPlainObject(parsed)) {
    throw new ToolError(
      "not-a-report",
      "The JSON is not a feature support report (expected an object of feature id to true or false).",
      `Recognized ids: ${FEATURE_PROBES.map((p) => p.id).join(", ")}.`,
    );
  }

  const results: Record<string, boolean> = {};
  let recognized = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "boolean" || !(key in PROBES_BY_ID)) continue;
    results[key] = value;
    recognized++;
  }

  if (recognized === 0) {
    throw new ToolError(
      "not-a-report",
      "None of the JSON's keys are a recognized WebAssembly feature id.",
      `Recognized ids: ${FEATURE_PROBES.map((p) => p.id).join(", ")}.`,
    );
  }

  return describeSupport(results);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, WasmFeatureDetectorOpts>;
