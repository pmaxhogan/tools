import { ToolError, type ToolLogic } from '../types';

export interface JsonToTypesOpts {
  /** Output language: 'typescript', 'zod', or 'kotlin'. */
  target?: string;
  /** Name for the root type. */
  rootName?: string;
  /** A null in the sample makes the property optional as well as nullable. */
  optionalNulls?: boolean;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Shape model                                                                 */
/* -------------------------------------------------------------------------- */

type Kind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

interface PropInfo {
  shape: Shape;
  /** How many object samples carried this key. */
  present: number;
}

interface ObjShape {
  props: Map<string, PropInfo>;
  /** How many objects were merged into this shape. */
  samples: number;
}

interface Shape {
  types: Set<Kind>;
  /** String stats, used to detect an all ISO date-time property. */
  strings: { total: number; iso: number };
  /** Number stats, used to pick Int, Long, or Double for Kotlin. */
  nums: { allInt: boolean; min: number; max: number };
  /** Merged shape of every object seen at this position. */
  obj: ObjShape | null;
  /** Merged shape of every array element seen at this position. */
  elem: Shape | null;
}

/** Full ISO 8601 date-time. A bare calendar date does not count. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|z|[+-]\d{2}:?\d{2})?$/;

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

function newShape(): Shape {
  return {
    types: new Set(),
    strings: { total: 0, iso: 0 },
    nums: { allInt: true, min: 0, max: 0 },
    obj: null,
    elem: null,
  };
}

/** Fold one sample value into a shape. Arrays merge every element together. */
function observe(shape: Shape, value: unknown): void {
  if (value === null) {
    shape.types.add('null');
    return;
  }
  if (Array.isArray(value)) {
    shape.types.add('array');
    if (!shape.elem) shape.elem = newShape();
    for (const item of value) observe(shape.elem, item);
    return;
  }
  const t = typeof value;
  if (t === 'object') {
    shape.types.add('object');
    if (!shape.obj) shape.obj = { props: new Map(), samples: 0 };
    const obj = shape.obj;
    obj.samples += 1;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      let info = obj.props.get(key);
      if (!info) {
        info = { shape: newShape(), present: 0 };
        obj.props.set(key, info);
      }
      info.present += 1;
      observe(info.shape, record[key]);
    }
    return;
  }
  if (t === 'string') {
    shape.types.add('string');
    shape.strings.total += 1;
    if (ISO_DATE_TIME.test(value as string)) shape.strings.iso += 1;
    return;
  }
  if (t === 'number') {
    shape.types.add('number');
    const n = value as number;
    if (!Number.isInteger(n)) shape.nums.allInt = false;
    shape.nums.min = Math.min(shape.nums.min, n);
    shape.nums.max = Math.max(shape.nums.max, n);
    return;
  }
  if (t === 'boolean') shape.types.add('boolean');
}

/** True when every string sampled here was a full ISO date-time. */
function isDateShape(shape: Shape): boolean {
  return shape.strings.total > 0 && shape.strings.iso === shape.strings.total;
}

/** An array position whose elements were never seen. */
function isEmptyArray(shape: Shape): boolean {
  return shape.types.has('array') && (!shape.elem || shape.elem.types.size === 0);
}

function notesFor(shape: Shape): string[] {
  const notes: string[] = [];
  if (isDateShape(shape)) notes.push('ISO date-time');
  else if (shape.elem && isDateShape(shape.elem)) notes.push('ISO date-time');
  if (isEmptyArray(shape)) notes.push('empty array in sample');
  return notes;
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                      */
/* -------------------------------------------------------------------------- */

interface NamedType {
  name: string;
  obj: ObjShape;
}

interface Ctx {
  names: Map<ObjShape, string>;
  order: NamedType[];
  rootTypeName: string;
  optionalNulls: boolean;
  usesJsonElement: boolean;
  usesSerialName: boolean;
}

function pascal(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  if (!joined) return 'Type';
  return /^[0-9]/.test(joined) ? `Type${joined}` : joined;
}

function camel(raw: string): string {
  const p = pascal(raw);
  const lowered = p.charAt(0).toLowerCase() + p.slice(1);
  return /^[0-9]/.test(lowered) ? `_${lowered}` : lowered;
}

/** Naive singularizer: enough for property names like items, boxes, entries. */
function singularize(name: string): string {
  if (/ss$/i.test(name)) return name;
  if (/ies$/i.test(name) && name.length > 3) return `${name.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/i.test(name)) return name.slice(0, -2);
  if (/s$/i.test(name) && name.length > 1) return name.slice(0, -1);
  return name;
}

function elementName(name: string, atRoot: boolean): string {
  const singular = singularize(name);
  if (singular !== name) return singular;
  return atRoot ? 'Item' : name;
}

function unique(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}${n}`)) n += 1;
  const picked = `${base}${n}`;
  used.add(picked);
  return picked;
}

/** Pre-order walk that gives every object shape a unique PascalCase name. */
function assignNames(
  root: Shape,
  rootName: string,
): { names: Map<ObjShape, string>; order: NamedType[]; rootTypeName: string } {
  const used = new Set<string>();
  const names = new Map<ObjShape, string>();
  const order: NamedType[] = [];
  const rootTypeName = pascal(rootName);

  function visit(shape: Shape, suggestion: string, atRoot: boolean): void {
    if (shape.obj && !names.has(shape.obj)) {
      const name = unique(pascal(suggestion), used);
      names.set(shape.obj, name);
      order.push({ name, obj: shape.obj });
      for (const [key, info] of shape.obj.props) visit(info.shape, key, false);
    }
    if (shape.elem) visit(shape.elem, elementName(suggestion, atRoot), false);
  }

  if (root.obj) {
    visit(root, rootName, true);
  } else {
    // The alias keeps the root name, so nested types must not reuse it.
    used.add(rootTypeName);
    visit(root, rootName, true);
  }

  return { names, order, rootTypeName };
}

/* -------------------------------------------------------------------------- */
/* TypeScript                                                                  */
/* -------------------------------------------------------------------------- */

const TS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function tsType(shape: Shape, ctx: Ctx): string {
  const parts: string[] = [];
  if (shape.types.has('string')) parts.push('string');
  if (shape.types.has('number')) parts.push('number');
  if (shape.types.has('boolean')) parts.push('boolean');
  if (shape.types.has('object') && shape.obj) parts.push(ctx.names.get(shape.obj) ?? 'unknown');
  if (shape.types.has('array')) {
    const inner = shape.elem && shape.elem.types.size > 0 ? tsType(shape.elem, ctx) : 'unknown';
    parts.push(inner.includes('|') ? `(${inner})[]` : `${inner}[]`);
  }
  // Only nulls (or nothing at all) were observed: nothing to name it.
  if (parts.length === 0) return 'unknown';
  if (shape.types.has('null')) parts.push('null');
  return parts.join(' | ');
}

function comment(notes: string[]): string {
  return notes.length ? ` // ${notes.join('; ')}` : '';
}

function tsInterface(name: string, obj: ObjShape, ctx: Ctx): string {
  if (obj.props.size === 0) return `export interface ${name} {}`;
  const lines: string[] = [];
  for (const [key, info] of obj.props) {
    const shape = info.shape;
    const missing = info.present < obj.samples;
    const optional = missing || (ctx.optionalNulls && shape.types.has('null'));
    const prop = TS_IDENT.test(key) ? key : JSON.stringify(key);
    lines.push(
      `  ${prop}${optional ? '?' : ''}: ${tsType(shape, ctx)};${comment(notesFor(shape))}`,
    );
  }
  return `export interface ${name} {\n${lines.join('\n')}\n}`;
}

function emitTypescript(root: Shape, ctx: Ctx): string {
  const blocks: string[] = [];
  if (!root.obj) blocks.push(`export type ${ctx.rootTypeName} = ${tsType(root, ctx)};`);
  for (const named of ctx.order) blocks.push(tsInterface(named.name, named.obj, ctx));
  return `${blocks.join('\n\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Zod                                                                         */
/* -------------------------------------------------------------------------- */

function zodType(shape: Shape, ctx: Ctx): string {
  const parts: string[] = [];
  if (shape.types.has('string')) {
    parts.push(isDateShape(shape) ? 'z.string().describe("ISO date-time")' : 'z.string()');
  }
  if (shape.types.has('number')) parts.push(shape.nums.allInt ? 'z.number().int()' : 'z.number()');
  if (shape.types.has('boolean')) parts.push('z.boolean()');
  if (shape.types.has('object') && shape.obj) {
    parts.push(`${ctx.names.get(shape.obj) ?? 'Unknown'}Schema`);
  }
  if (shape.types.has('array')) {
    const inner =
      shape.elem && shape.elem.types.size > 0 ? zodType(shape.elem, ctx) : 'z.unknown()';
    parts.push(`z.array(${inner})`);
  }
  if (parts.length === 0) return shape.types.has('null') ? 'z.null()' : 'z.unknown()';
  let out = parts.length === 1 ? parts[0] : `z.union([${parts.join(', ')}])`;
  if (shape.types.has('null')) out += '.nullable()';
  return out;
}

function zodSchema(name: string, obj: ObjShape, ctx: Ctx): string {
  if (obj.props.size === 0) return `export const ${name}Schema = z.object({});`;
  const lines: string[] = [];
  for (const [key, info] of obj.props) {
    const shape = info.shape;
    const missing = info.present < obj.samples;
    const optional = missing || (ctx.optionalNulls && shape.types.has('null'));
    const prop = TS_IDENT.test(key) ? key : JSON.stringify(key);
    lines.push(`  ${prop}: ${zodType(shape, ctx)}${optional ? '.optional()' : ''},`);
  }
  return `export const ${name}Schema = z.object({\n${lines.join('\n')}\n});`;
}

function emitZod(root: Shape, ctx: Ctx): string {
  const blocks: string[] = ['import { z } from "zod";'];
  // Reverse pre-order puts every child schema before the parent that uses it.
  for (const named of [...ctx.order].reverse()) {
    blocks.push(zodSchema(named.name, named.obj, ctx));
  }
  const inferNames: string[] = [];
  if (!root.obj) {
    blocks.push(`export const ${ctx.rootTypeName}Schema = ${zodType(root, ctx)};`);
    inferNames.push(ctx.rootTypeName);
  }
  for (const named of ctx.order) inferNames.push(named.name);
  blocks.push(inferNames.map((n) => `export type ${n} = z.infer<typeof ${n}Schema>;`).join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Kotlin                                                                      */
/* -------------------------------------------------------------------------- */

const KOTLIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function kotlinNumber(nums: { allInt: boolean; min: number; max: number }): string {
  if (!nums.allInt) return 'Double';
  return nums.max > INT32_MAX || nums.min < INT32_MIN ? 'Long' : 'Int';
}

function kotlinType(shape: Shape, ctx: Ctx, notes: string[]): string {
  const parts: string[] = [];
  if (shape.types.has('string')) parts.push('String');
  if (shape.types.has('number')) parts.push(kotlinNumber(shape.nums));
  if (shape.types.has('boolean')) parts.push('Boolean');
  if (shape.types.has('object') && shape.obj) parts.push(ctx.names.get(shape.obj) ?? 'JsonElement');
  if (shape.types.has('array')) {
    let inner: string;
    if (shape.elem && shape.elem.types.size > 0) {
      inner = kotlinType(shape.elem, ctx, notes);
    } else {
      ctx.usesJsonElement = true;
      inner = 'JsonElement';
    }
    parts.push(`List<${inner}>`);
  }
  if (parts.length === 0) {
    ctx.usesJsonElement = true;
    return 'JsonElement';
  }
  if (parts.length === 1) return parts[0];
  // No single Kotlin type covers the sampled values, so fall back and say so.
  ctx.usesJsonElement = true;
  notes.push(`mixed types in sample: ${parts.join(', ')}`);
  return 'JsonElement';
}

function kotlinDataClass(name: string, obj: ObjShape, ctx: Ctx): string {
  if (obj.props.size === 0) return `@Serializable\nclass ${name}`;
  const lines: string[] = [];
  for (const [key, info] of obj.props) {
    const shape = info.shape;
    const missing = info.present < obj.samples;
    const optional = missing || (ctx.optionalNulls && shape.types.has('null'));
    const notes = notesFor(shape);
    const type = kotlinType(shape, ctx, notes);
    const nullable = optional || shape.types.has('null');
    const propName = KOTLIN_IDENT.test(key) ? key : camel(key);
    let prefix = '';
    if (propName !== key) {
      ctx.usesSerialName = true;
      prefix = `@SerialName(${JSON.stringify(key)}) `;
    }
    lines.push(
      `    ${prefix}val ${propName}: ${type}${nullable ? '?' : ''}${optional ? ' = null' : ''},${comment(notes)}`,
    );
  }
  // Kotlin allows a trailing comma, but drop it for the last parameter anyway.
  const last = lines.length - 1;
  lines[last] = lines[last].replace(/,(\s*\/\/.*)?$/, '$1');
  return `@Serializable\ndata class ${name}(\n${lines.join('\n')}\n)`;
}

function emitKotlin(root: Shape, ctx: Ctx): string {
  const blocks: string[] = [];
  if (!root.obj) {
    const notes = notesFor(root);
    const type = kotlinType(root, ctx, notes);
    const nullable = root.types.has('null');
    blocks.push(`typealias ${ctx.rootTypeName} = ${type}${nullable ? '?' : ''}${comment(notes)}`);
  }
  for (const named of ctx.order) blocks.push(kotlinDataClass(named.name, named.obj, ctx));

  const imports: string[] = [];
  if (ctx.usesSerialName) imports.push('import kotlinx.serialization.SerialName');
  if (ctx.order.length > 0) imports.push('import kotlinx.serialization.Serializable');
  if (ctx.usesJsonElement) imports.push('import kotlinx.serialization.json.JsonElement');
  if (imports.length) blocks.unshift(imports.join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const TARGETS = new Set(['typescript', 'zod', 'kotlin']);

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ToolError(
      'invalid-json',
      `Could not parse the input as JSON: ${detail}`,
      'Check for trailing commas, single quotes, unquoted keys, or a truncated value at the reported position.',
    );
  }
}

export function run(input: string, opts: JsonToTypesOpts): string {
  const raw = (input ?? '').trim();
  if (!raw) {
    throw new ToolError(
      'empty-input',
      'Paste a sample JSON document to generate types from.',
      'Any JSON value works: an object, an array of objects, or a single string or number.',
    );
  }

  const target = String(opts.target ?? 'typescript');
  if (!TARGETS.has(target)) {
    throw new ToolError(
      'bad-target',
      `Unknown target "${target}".`,
      'Choose typescript, zod, or kotlin.',
    );
  }

  const rootName = String(opts.rootName ?? '').trim() || 'Root';
  const optionalNulls = opts.optionalNulls !== false;

  const parsed = parseJson(raw);
  const root = newShape();
  observe(root, parsed);

  const { names, order, rootTypeName } = assignNames(root, rootName);
  const ctx: Ctx = {
    names,
    order,
    rootTypeName,
    optionalNulls,
    usesJsonElement: false,
    usesSerialName: false,
  };

  if (target === 'zod') return emitZod(root, ctx);
  if (target === 'kotlin') return emitKotlin(root, ctx);
  return emitTypescript(root, ctx);
}

export default { run } satisfies ToolLogic<string, string, JsonToTypesOpts>;
