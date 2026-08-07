import { ToolError, type ToolLogic } from "../types";

export type Operation = "inspect" | "json" | "reencode" | "repair" | "strip";

export interface FactorioOpts {
  /** What to do with the pasted string. Default "inspect". */
  operation?: Operation;
  /** Strip mode: drop trees, rocks and other environment entities. Default true. */
  stripTrees?: boolean;
  /** Strip mode: clear every module and item request on every entity. */
  stripRequests?: boolean;
  /** Strip mode: drop the tile layer (concrete, stone paths, landfill). */
  stripTiles?: boolean;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* tiny typed accessors                                                */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;

function asObject(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/* ------------------------------------------------------------------ */
/* base64                                                              */
/* ------------------------------------------------------------------ */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i] as string] = i;

/** Standard base64 with padding. Built by hand so the logic stays portable. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    let quad = (B64[b0 >> 2] as string) + (B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] as string);
    quad += b1 === undefined ? "=" : (B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] as string);
    quad += b2 === undefined ? "=" : (B64[b2 & 0x3f] as string);
    parts.push(quad);
  }
  return parts.join("");
}

/** Strict: any character outside the alphabet returns null. */
export function base64ToBytes(raw: string): Uint8Array | null {
  const core = raw.replace(/=+$/, "");
  if (core.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((core.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of core) {
    const v = B64_INDEX[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/* ------------------------------------------------------------------ */
/* zlib deflate via the platform streams                               */
/* ------------------------------------------------------------------ */

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function pump(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const [out] = await Promise.all([
    collect(transform.readable),
    writer.write(bytes as BufferSource).then(() => writer.close()),
  ]);
  return out;
}

/**
 * Factorio uses zlib-wrapped deflate, which is what the "deflate" algorithm
 * name means for CompressionStream. Returns null instead of throwing so the
 * repair pass can try again with a shorter payload.
 */
async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await pump(bytes, new DecompressionStream("deflate"));
  } catch {
    return null;
  }
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new CompressionStream("deflate"));
}

/* ------------------------------------------------------------------ */
/* the string format                                                   */
/* ------------------------------------------------------------------ */

const VERSION_BYTE = "0";
const ROOT_KEYS = ["blueprint", "blueprint_book", "deconstruction_planner", "upgrade_planner"];

export interface Decoded {
  root: Obj;
  jsonText: string;
  compressedLength: number;
}

/** Turns "0eNq..." into the parsed JSON, with an honest error at each stage. */
export async function decodeBlueprintString(raw: string): Promise<Decoded> {
  const compact = raw.replace(/\s+/g, "");
  if (compact === "") {
    throw new ToolError(
      "empty-input",
      "Enter a Factorio blueprint string.",
      'Copy a blueprint to your clipboard in game with the "Export to string" button, then paste it here.',
    );
  }

  const first = compact[0] as string;
  if (first !== VERSION_BYTE) {
    throw new ToolError(
      "unsupported-version",
      `This string starts with the version byte "${first}", but every blueprint Factorio has exported since 0.15 starts with "0".`,
      "Check that you pasted the whole string starting from its very first character. If it really does start with another digit, it comes from a format this decoder does not know.",
    );
  }

  const body = compact.slice(1);
  if (body === "") {
    throw new ToolError(
      "empty-payload",
      'The string is just the version byte "0" with no compressed data after it.',
      "Copy the blueprint again. A real string is hundreds of characters long.",
    );
  }

  const bytes = base64ToBytes(body);
  if (bytes === null) {
    throw new ToolError(
      "invalid-base64",
      "The text after the version byte is not valid base64, so it cannot be turned back into bytes.",
      "Run the repair operation. It removes line breaks, trailing junk and URL-encoded characters that chat clients and forums add.",
    );
  }

  const inflated = await inflate(bytes);
  if (inflated === null) {
    throw new ToolError(
      "invalid-compression",
      "The base64 decoded fine but the bytes are not a zlib deflate stream, so the blueprint payload could not be decompressed.",
      "The string is probably truncated or has characters missing in the middle. Copy it again from the game and try the repair operation.",
    );
  }

  const jsonText = new TextDecoder().decode(inflated);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new ToolError(
      "invalid-json",
      `The payload decompressed but is not valid JSON: ${(e as Error).message}`,
      "This is not a Factorio blueprint. Some other tools reuse the same base64 and deflate wrapper for different data.",
    );
  }

  const root = asObject(parsed);
  if (!root) {
    throw new ToolError(
      "invalid-json",
      "The payload decompressed to JSON, but the top level is not an object.",
      'A Factorio blueprint is always a JSON object with a "blueprint" or "blueprint_book" key.',
    );
  }

  return { root, jsonText, compressedLength: bytes.length };
}

/** Turns a blueprint object back into a pasteable "0..." string. */
export async function encodeBlueprintString(root: Obj): Promise<string> {
  const json = JSON.stringify(root);
  const compressed = await deflate(new TextEncoder().encode(json));
  return VERSION_BYTE + bytesToBase64(compressed);
}

function assertBlueprintRoot(root: Obj): void {
  if (ROOT_KEYS.some((k) => asObject(root[k]) !== null)) return;
  const keys = Object.keys(root);
  throw new ToolError(
    "not-a-blueprint",
    `The JSON has no "blueprint" or "blueprint_book" key at the top level (it has ${
      keys.length === 0 ? "no keys at all" : `: ${keys.slice(0, 8).join(", ")}`
    }).`,
    'Wrap your object so it reads {"blueprint": { ... }} or {"blueprint_book": { ... }}. Factorio rejects anything else.',
  );
}

/* ------------------------------------------------------------------ */
/* version numbers                                                     */
/* ------------------------------------------------------------------ */

/** Factorio packs a version into one u64 as four u16 fields. */
export function splitVersion(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const packed = BigInt(Math.trunc(value));
  const field = (shift: bigint) => Number((packed >> shift) & 0xffffn);
  return `${field(48n)}.${field(32n)}.${field(16n)}.${field(0n)}`;
}

/* ------------------------------------------------------------------ */
/* summary helpers                                                     */
/* ------------------------------------------------------------------ */

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Both the 1.x record shape and the 2.0 request-array shape, as name -> count. */
export function itemRequestCounts(items: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (name: string, count: number) => {
    if (!name) return;
    out[name] = (out[name] ?? 0) + count;
  };

  if (Array.isArray(items)) {
    for (const entry of items) {
      const req = asObject(entry);
      if (!req) continue;
      const id = asObject(req["id"]);
      const name = asString(id ? id["name"] : req["name"]) ?? "";
      let count = 0;
      const holder = asObject(req["items"]);
      if (holder) {
        for (const slot of asArray(holder["in_inventory"])) {
          const s = asObject(slot);
          const c = s ? s["count"] : undefined;
          count += typeof c === "number" ? c : 1;
        }
        count += asArray(holder["grid"]).length;
      }
      if (typeof req["count"] === "number") count += req["count"] as number;
      add(name, count === 0 ? 1 : count);
    }
    return out;
  }

  const record = asObject(items);
  if (record) {
    for (const [name, value] of Object.entries(record)) {
      if (typeof value === "number") add(name, value);
    }
  }
  return out;
}

function iconLabel(icon: unknown): string | null {
  const entry = asObject(icon);
  if (!entry) return null;
  const signal = asObject(entry["signal"]) ?? entry;
  const name = asString(signal["name"]);
  if (!name) return null;
  const type = asString(signal["type"]);
  return type ? `${type}/${name}` : name;
}

interface WireTally {
  wires: number;
  endpoints: number;
  neighbours: number;
}

function tallyWires(bp: Obj, entities: Obj[]): WireTally {
  const tally: WireTally = { wires: asArray(bp["wires"]).length, endpoints: 0, neighbours: 0 };
  for (const entity of entities) {
    const connections = asObject(entity["connections"]);
    if (connections) {
      for (const side of Object.values(connections)) {
        const sideObj = asObject(side);
        if (!sideObj) continue;
        for (const colour of Object.values(sideObj)) tally.endpoints += asArray(colour).length;
      }
    }
    tally.neighbours += asArray(entity["neighbours"]).length;
  }
  return tally;
}

const ENVIRONMENT_EXACT = new Set(["fish", "dead-grey-trunk", "crash-site-spaceship"]);

/** Trees, rocks and the other decoratives Factorio copies into a blueprint. */
export function isEnvironmentEntity(name: string): boolean {
  const n = name.toLowerCase();
  if (ENVIRONMENT_EXACT.has(n)) return true;
  if (n.startsWith("tree-")) return true;
  if (n.endsWith("-tree") || n.endsWith("-trunk")) return true;
  if (n.includes("dead-tree") || n.includes("dry-tree")) return true;
  return /(^|-)rock(-|$)/.test(n);
}

function entityList(bp: Obj): Obj[] {
  const out: Obj[] = [];
  for (const raw of asArray(bp["entities"])) {
    const entity = asObject(raw);
    if (entity) out.push(entity);
  }
  return out;
}

function countByName(items: Obj[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = asString(item["name"]) ?? "(unnamed)";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const MAX_ROWS = 40;

function tableRows(counts: [string, number][], indent: string): string[] {
  const lines: string[] = [];
  const width = Math.min(
    38,
    Math.max(...counts.slice(0, MAX_ROWS).map(([name]) => name.length), 1),
  );
  for (const [name, count] of counts.slice(0, MAX_ROWS)) {
    lines.push(`${indent}${name.padEnd(width)}  ${count}`);
  }
  if (counts.length > MAX_ROWS) {
    lines.push(`${indent}... and ${counts.length - MAX_ROWS} more distinct names`);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* inspect                                                             */
/* ------------------------------------------------------------------ */

function describeBlueprint(bp: Obj, pad: string, lines: string[]): void {
  const version = splitVersion(bp["version"]);
  if (version) lines.push(`${pad}Game version: ${version} (packed ${String(bp["version"])})`);

  const description = asString(bp["description"]);
  if (description) lines.push(`${pad}Description: ${description.replace(/\s*\n\s*/g, " / ")}`);

  const icons = asArray(bp["icons"])
    .map(iconLabel)
    .filter((x): x is string => x !== null);
  lines.push(`${pad}Icons: ${icons.length ? icons.join(", ") : "none"}`);

  const entities = entityList(bp);
  const counts = countByName(entities);
  lines.push(
    `${pad}Entities: ${plural(entities.length, "entity", "entities")}, ${plural(counts.length, "distinct name")}`,
  );
  lines.push(...tableRows(counts, `${pad}  `));

  const tiles: Obj[] = [];
  for (const raw of asArray(bp["tiles"])) {
    const tile = asObject(raw);
    if (tile) tiles.push(tile);
  }
  if (tiles.length) {
    const tileCounts = countByName(tiles);
    lines.push(
      `${pad}Tiles: ${plural(tiles.length, "tile")} (${tileCounts
        .slice(0, 6)
        .map(([name, n]) => `${name} ${n}`)
        .join(", ")})`,
    );
  } else {
    lines.push(`${pad}Tiles: none`);
  }

  let requestingEntities = 0;
  const requested: Record<string, number> = {};
  for (const entity of entities) {
    const counted = itemRequestCounts(entity["items"]);
    const names = Object.keys(counted);
    if (names.length === 0) continue;
    requestingEntities++;
    for (const name of names) requested[name] = (requested[name] ?? 0) + (counted[name] as number);
  }
  if (requestingEntities === 0) {
    lines.push(`${pad}Item requests: none`);
  } else {
    const detail = Object.entries(requested)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n]) => `${name} x${n}`)
      .join(", ");
    lines.push(
      `${pad}Item requests: ${plural(requestingEntities, "entity", "entities")} requesting ${detail}`,
    );
  }

  const wires = tallyWires(bp, entities);
  const wireParts: string[] = [];
  if (wires.wires) wireParts.push(`${plural(wires.wires, "wire")} in the 2.0 wire list`);
  if (wires.endpoints)
    wireParts.push(
      `${plural(wires.endpoints, "circuit connection endpoint")} in the 1.x style, where each wire is listed on both of the entities it joins`,
    );
  if (wires.neighbours) wireParts.push(`${plural(wires.neighbours, "power pole neighbour")}`);
  lines.push(
    `${pad}Wires and circuit connections: ${wireParts.length ? wireParts.join("; ") : "none"}`,
  );

  const xs: number[] = [];
  const ys: number[] = [];
  for (const entity of entities) {
    const position = asObject(entity["position"]);
    if (!position) continue;
    const x = position["x"];
    const y = position["y"];
    if (typeof x === "number" && Number.isFinite(x)) xs.push(x);
    if (typeof y === "number" && Number.isFinite(y)) ys.push(y);
  }
  if (xs.length && ys.length) {
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    lines.push(
      `${pad}Footprint: ${num(maxX - minX + 1)} x ${num(maxY - minY + 1)} tiles (x ${num(minX)} to ${num(maxX)}, y ${num(minY)} to ${num(maxY)})`,
    );
  } else {
    lines.push(`${pad}Footprint: no entity positions to measure`);
  }

  const snap = asObject(bp["snap-to-grid"]);
  if (snap) lines.push(`${pad}Snap to grid: ${num(Number(snap["x"]))} x ${num(Number(snap["y"]))}`);
}

function describePlanner(kind: string, planner: Obj, pad: string, lines: string[]): void {
  const version = splitVersion(planner["version"]);
  if (version) lines.push(`${pad}Game version: ${version} (packed ${String(planner["version"])})`);
  const settings = asObject(planner["settings"]);
  if (settings) {
    const filters = asArray(settings["filters"]).length + asArray(settings["mappers"]).length;
    lines.push(`${pad}Filters: ${filters}`);
  }
  lines.push(
    `${pad}This is a ${kind.replace(/_/g, " ")}, not a blueprint, so it holds settings rather than entities.`,
  );
}

function describeRoot(root: Obj, pad: string, lines: string[], heading = ""): void {
  const book = asObject(root["blueprint_book"]);
  if (book) {
    const label = asString(book["label"]) ?? "(no label)";
    lines.push(`${pad}${heading}Blueprint book: ${label}`);
    const version = splitVersion(book["version"]);
    if (version) lines.push(`${pad}  Game version: ${version} (packed ${String(book["version"])})`);
    const description = asString(book["description"]);
    if (description) lines.push(`${pad}  Description: ${description.replace(/\s*\n\s*/g, " / ")}`);
    const icons = asArray(book["icons"])
      .map(iconLabel)
      .filter((x): x is string => x !== null);
    lines.push(`${pad}  Icons: ${icons.length ? icons.join(", ") : "none"}`);
    const children = asArray(book["blueprints"]);
    lines.push(`${pad}  Contains: ${plural(children.length, "entry", "entries")}`);
    children.forEach((raw, i) => {
      const child = asObject(raw);
      lines.push("");
      if (!child) {
        lines.push(`${pad}  [${i}] unreadable entry`);
        return;
      }
      describeRoot(child, `${pad}  `, lines, `[${i}] `);
    });
    return;
  }

  const bp = asObject(root["blueprint"]);
  if (bp) {
    const label = asString(bp["label"]) ?? "(no label)";
    lines.push(`${pad}${heading}Blueprint: ${label}`);
    describeBlueprint(bp, `${pad}  `, lines);
    return;
  }

  for (const kind of ["deconstruction_planner", "upgrade_planner"]) {
    const planner = asObject(root[kind]);
    if (!planner) continue;
    const label = asString(planner["label"]) ?? "(no label)";
    lines.push(
      `${pad}${heading}${kind === "upgrade_planner" ? "Upgrade planner" : "Deconstruction planner"}: ${label}`,
    );
    describePlanner(kind, planner, `${pad}  `, lines);
    return;
  }

  const keys = Object.keys(root);
  lines.push(`${pad}${heading}Unrecognized root object with keys: ${keys.join(", ") || "none"}`);
  lines.push(`${pad}  Factorio expects a "blueprint" or "blueprint_book" key here.`);
}

function inspectReport(decoded: Decoded): string {
  const lines: string[] = [];
  lines.push(
    `Decoded: version byte 0, ${plural(decoded.compressedLength, "compressed byte")} of zlib deflate, ${plural(decoded.jsonText.length, "character")} of JSON.`,
  );
  lines.push("");
  describeRoot(decoded.root, "", lines);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* repair                                                              */
/* ------------------------------------------------------------------ */

interface RepairResult {
  decoded: Decoded;
  fixes: string[];
}

/** Attempts a decode, then progressively shorter payloads, tolerating junk. */
async function tryDecodeBody(body: string): Promise<Decoded | null> {
  for (let drop = 0; drop <= 8 && drop < body.length; drop++) {
    let candidate = body.slice(0, body.length - drop).replace(/=+$/, "");
    if (candidate.length % 4 === 1) continue;
    while (candidate.length % 4 !== 0) candidate += "=";
    const bytes = base64ToBytes(candidate);
    if (!bytes || bytes.length === 0) continue;
    const inflated = await inflate(bytes);
    if (!inflated) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(inflated));
    } catch {
      continue;
    }
    const root = asObject(parsed);
    if (!root) continue;
    return { root, jsonText: JSON.stringify(parsed), compressedLength: bytes.length };
  }
  return null;
}

async function repairString(raw: string): Promise<RepairResult> {
  if (raw.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Enter the mangled blueprint string you want repaired.",
      "Paste whatever you were sent, line breaks and all. That is exactly what this operation is for.",
    );
  }

  const fixes: string[] = [];
  let text = raw;

  const trimmed = text.trim();
  if (trimmed !== text) fixes.push("Trimmed leading and trailing whitespace.");
  text = trimmed;

  const inner = text.match(/\s/g);
  if (inner) {
    fixes.push(
      `Removed ${plural(inner.length, "whitespace character")} from inside the string, which is how chat clients and forums wrap long lines.`,
    );
    text = text.replace(/\s+/g, "");
  }

  const percent = text.match(/%[0-9a-fA-F]{2}/g);
  if (percent) {
    const before = text;
    text = text
      .replace(/%2[bB]/g, "+")
      .replace(/%2[fF]/g, "/")
      .replace(/%3[dD]/g, "=");
    if (text !== before) {
      fixes.push(
        `Decoded ${plural(percent.length, "URL-encoded character")} such as %2B back to plus signs, which happens when a string travels through a link or a form.`,
      );
    }
  }

  if (/[-_]/.test(text) && !/[+/]/.test(text)) {
    text = text.replace(/-/g, "+").replace(/_/g, "/");
    fixes.push(
      'Converted URL-safe base64 characters ("-" and "_") back to the standard "+" and "/".',
    );
  }

  let body = text;
  let addedVersionByte = false;
  if (text[0] === VERSION_BYTE) {
    body = text.slice(1);
  } else {
    addedVersionByte = true;
  }

  const cutAt = body.search(/[^A-Za-z0-9+/=]/);
  if (cutAt >= 0) {
    fixes.push(
      `Cut ${plural(body.length - cutAt, "trailing character")} of junk that is not part of the base64 payload.`,
    );
    body = body.slice(0, cutAt);
  }

  let decoded = await tryDecodeBody(body);
  if (!decoded && !addedVersionByte) {
    // Maybe the leading "0" was a real payload character and the version byte
    // was lost, so try the whole thing as the payload instead.
    const alt = await tryDecodeBody(text);
    if (alt) {
      decoded = alt;
      addedVersionByte = true;
    }
  }

  if (!decoded) {
    throw new ToolError(
      "unrepairable",
      "Even after removing whitespace, URL encoding and trailing junk, the payload still does not decompress into blueprint JSON.",
      "Characters are probably missing from the middle of the string, which no repair can invent. Copy it again from the game or ask the sender to post it as a file or a pastebin link.",
    );
  }

  if (addedVersionByte) fixes.push('Added the missing leading version byte "0".');
  if (fixes.length === 0) fixes.push("Nothing needed fixing. The string decoded on the first try.");

  return { decoded, fixes };
}

/* ------------------------------------------------------------------ */
/* strip                                                               */
/* ------------------------------------------------------------------ */

function forEachBlueprint(root: Obj, fn: (bp: Obj) => void): void {
  const bp = asObject(root["blueprint"]);
  if (bp) {
    fn(bp);
    return;
  }
  const book = asObject(root["blueprint_book"]);
  if (!book) return;
  for (const raw of asArray(book["blueprints"])) {
    const child = asObject(raw);
    if (child) forEachBlueprint(child, fn);
  }
}

interface StripTally {
  removedEntities: Map<string, number>;
  clearedEntities: number;
  clearedItems: number;
  removedTiles: number;
}

function stripBlueprints(root: Obj, opts: FactorioOpts): StripTally {
  const tally: StripTally = {
    removedEntities: new Map(),
    clearedEntities: 0,
    clearedItems: 0,
    removedTiles: 0,
  };

  forEachBlueprint(root, (bp) => {
    if (opts.stripTrees) {
      const entities = asArray(bp["entities"]);
      if (entities.length) {
        const kept = entities.filter((raw) => {
          const entity = asObject(raw);
          const name = entity ? asString(entity["name"]) : null;
          if (!name || !isEnvironmentEntity(name)) return true;
          tally.removedEntities.set(name, (tally.removedEntities.get(name) ?? 0) + 1);
          return false;
        });
        bp["entities"] = kept;
      }
    }

    if (opts.stripRequests) {
      for (const raw of asArray(bp["entities"])) {
        const entity = asObject(raw);
        if (!entity || entity["items"] === undefined || entity["items"] === null) continue;
        const counted = itemRequestCounts(entity["items"]);
        tally.clearedEntities++;
        tally.clearedItems += Object.values(counted).reduce((a, b) => a + b, 0);
        delete entity["items"];
      }
    }

    if (opts.stripTiles) {
      const tiles = asArray(bp["tiles"]);
      if (tiles.length) {
        tally.removedTiles += tiles.length;
        delete bp["tiles"];
      }
    }
  });

  return tally;
}

function stripReport(tally: StripTally, opts: FactorioOpts): string[] {
  const lines: string[] = [];
  if (!opts.stripTrees && !opts.stripRequests && !opts.stripTiles) {
    lines.push(
      "No strip options were selected, so nothing was removed and the string was re-encoded as is.",
    );
    return lines;
  }

  if (opts.stripTrees) {
    const total = [...tally.removedEntities.values()].reduce((a, b) => a + b, 0);
    if (total === 0) {
      lines.push("Environment entities: none found, nothing removed.");
    } else {
      const detail = [...tally.removedEntities.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, n]) => `${name} x${n}`)
        .join(", ");
      lines.push(
        `Removed ${plural(total, "environment entity", "environment entities")}: ${detail}`,
      );
    }
  }

  if (opts.stripRequests) {
    if (tally.clearedEntities === 0) {
      lines.push("Item requests: none found, nothing cleared.");
    } else {
      lines.push(
        `Cleared item requests on ${plural(tally.clearedEntities, "entity", "entities")} (${plural(tally.clearedItems, "requested item")}).`,
      );
    }
  }

  if (opts.stripTiles) {
    lines.push(
      tally.removedTiles === 0
        ? "Tiles: none found, nothing removed."
        : `Removed the tile layer (${plural(tally.removedTiles, "tile")}).`,
    );
  }

  lines.push(
    "Every remaining entity keeps its original entity_number, so wires and circuit connections still point at the right entities.",
  );
  return lines;
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

const OPERATIONS: Operation[] = ["inspect", "json", "reencode", "repair", "strip"];

export async function run(input: string, opts: FactorioOpts = {}): Promise<string> {
  const raw = typeof input === "string" ? input : "";
  const operation = (opts.operation ?? "inspect") as Operation;
  if (!OPERATIONS.includes(operation)) {
    throw new ToolError(
      "unknown-operation",
      `"${String(opts.operation)}" is not an operation this tool knows.`,
      `Pick one of: ${OPERATIONS.join(", ")}.`,
    );
  }

  if (operation === "reencode") {
    if (raw.trim() === "") {
      throw new ToolError(
        "empty-input",
        "Paste the blueprint JSON you want turned back into a blueprint string.",
        "Run the json operation first, edit the result, then paste it here.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new ToolError(
        "invalid-json",
        `That is not valid JSON: ${(e as Error).message}`,
        "Check for a trailing comma or an unquoted key. The json operation always produces text this operation accepts.",
      );
    }
    const root = asObject(parsed);
    if (!root) {
      throw new ToolError(
        "invalid-json",
        "The JSON parsed but its top level is not an object.",
        'A blueprint is always a JSON object, for example {"blueprint": { ... }}.',
      );
    }
    assertBlueprintRoot(root);
    return encodeBlueprintString(root);
  }

  if (operation === "repair") {
    const { decoded, fixes } = await repairString(raw);
    const clean = await encodeBlueprintString(decoded.root);
    const lines: string[] = ["Repair report"];
    for (const fix of fixes) lines.push(`  ${fix}`);
    lines.push("");
    lines.push(inspectReport(decoded));
    lines.push("");
    lines.push("Clean blueprint string");
    lines.push(clean);
    return lines.join("\n");
  }

  const decoded = await decodeBlueprintString(raw);

  if (operation === "json") {
    return JSON.stringify(decoded.root, null, 2);
  }

  if (operation === "strip") {
    const wanted: FactorioOpts = {
      stripTrees: opts.stripTrees !== false,
      stripRequests: opts.stripRequests === true,
      stripTiles: opts.stripTiles === true,
    };
    const tally = stripBlueprints(decoded.root, wanted);
    const clean = await encodeBlueprintString(decoded.root);
    const lines: string[] = ["Strip report"];
    for (const line of stripReport(tally, wanted)) lines.push(`  ${line}`);
    lines.push("");
    lines.push("Stripped blueprint string");
    lines.push(clean);
    return lines.join("\n");
  }

  return inspectReport(decoded);
}

export default { run } satisfies ToolLogic<string, string, FactorioOpts>;
