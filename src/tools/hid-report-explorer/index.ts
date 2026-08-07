import { ToolError, type ToolLogic } from "../types";

/**
 * HID report descriptor parser and report decoder.
 *
 * Two entry points into the same model:
 *
 *  - `parseReportDescriptor` reads the raw bytes of a USB HID report
 *    descriptor (the item stream defined by the HID 1.11 spec, section 6.2.2)
 *    and produces both a readable item tree and a computed report layout.
 *  - `layoutsFromCollections` builds the same layout shape from the already
 *    parsed collection tree that WebHID hands to the browser, because WebHID
 *    never exposes the raw descriptor bytes.
 *
 * `decodeInputReport` then turns report payload bytes into named field
 * values using either layout. Everything here is pure: no DOM, no device.
 */

/* ------------------------------------------------------------------ *
 * usage tables
 * ------------------------------------------------------------------ */

const USAGE_PAGES: Record<number, string> = {
  0x00: "Undefined",
  0x01: "Generic Desktop",
  0x02: "Simulation Controls",
  0x03: "VR Controls",
  0x04: "Sport Controls",
  0x05: "Game Controls",
  0x06: "Generic Device Controls",
  0x07: "Keyboard/Keypad",
  0x08: "LED",
  0x09: "Button",
  0x0a: "Ordinal",
  0x0b: "Telephony Device",
  0x0c: "Consumer",
  0x0d: "Digitizers",
  0x0e: "Haptics",
  0x0f: "Physical Input Device",
  0x10: "Unicode",
  0x11: "SoC",
  0x12: "Eye and Head Trackers",
  0x14: "Auxiliary Display",
  0x20: "Sensors",
  0x40: "Medical Instrument",
  0x41: "Braille Display",
  0x59: "Lighting and Illumination",
  0x80: "Monitor",
  0x84: "Power Device",
  0x85: "Battery System",
  0x8c: "Barcode Scanner",
  0x8d: "Weighing Device",
  0x8e: "Magnetic Stripe Reader",
  0x90: "Camera Control",
  0x91: "Arcade",
  0x92: "Gaming Device",
  0xf1d0: "FIDO Alliance",
};

const GENERIC_DESKTOP_USAGES: Record<number, string> = {
  0x01: "Pointer",
  0x02: "Mouse",
  0x04: "Joystick",
  0x05: "Game Pad",
  0x06: "Keyboard",
  0x07: "Keypad",
  0x08: "Multi-axis Controller",
  0x09: "Tablet PC System Controls",
  0x30: "X",
  0x31: "Y",
  0x32: "Z",
  0x33: "Rx",
  0x34: "Ry",
  0x35: "Rz",
  0x36: "Slider",
  0x37: "Dial",
  0x38: "Wheel",
  0x39: "Hat switch",
  0x3a: "Counted Buffer",
  0x3b: "Byte Count",
  0x3c: "Motion Wakeup",
  0x3d: "Start",
  0x3e: "Select",
  0x40: "Vx",
  0x41: "Vy",
  0x42: "Vz",
  0x43: "Vbrx",
  0x44: "Vbry",
  0x45: "Vbrz",
  0x46: "Vno",
  0x48: "Resolution Multiplier",
  0x80: "System Control",
  0x81: "System Power Down",
  0x82: "System Sleep",
  0x83: "System Wake Up",
  0x84: "System Context Menu",
  0x85: "System Main Menu",
  0x90: "D-pad Up",
  0x91: "D-pad Down",
  0x92: "D-pad Right",
  0x93: "D-pad Left",
};

const KEYBOARD_USAGES: Record<number, string> = {
  0x00: "No event",
  0x01: "Error roll over",
  0x02: "POST fail",
  0x03: "Error undefined",
  0x28: "Enter",
  0x29: "Escape",
  0x2a: "Backspace",
  0x2b: "Tab",
  0x2c: "Space",
  0x2d: "-",
  0x2e: "=",
  0x2f: "[",
  0x30: "]",
  0x31: "\\",
  0x32: "Non-US #",
  0x33: ";",
  0x34: "'",
  0x35: "`",
  0x36: ",",
  0x37: ".",
  0x38: "/",
  0x39: "Caps Lock",
  0x46: "Print Screen",
  0x47: "Scroll Lock",
  0x48: "Pause",
  0x49: "Insert",
  0x4a: "Home",
  0x4b: "Page Up",
  0x4c: "Delete",
  0x4d: "End",
  0x4e: "Page Down",
  0x4f: "Right Arrow",
  0x50: "Left Arrow",
  0x51: "Down Arrow",
  0x52: "Up Arrow",
  0x53: "Num Lock",
  0x54: "Keypad /",
  0x55: "Keypad *",
  0x56: "Keypad -",
  0x57: "Keypad +",
  0x58: "Keypad Enter",
  0x62: "Keypad 0",
  0x63: "Keypad .",
  0x65: "Application",
  0x66: "Power",
  0xe0: "Left Control",
  0xe1: "Left Shift",
  0xe2: "Left Alt",
  0xe3: "Left GUI",
  0xe4: "Right Control",
  0xe5: "Right Shift",
  0xe6: "Right Alt",
  0xe7: "Right GUI",
};

const LED_USAGES: Record<number, string> = {
  0x01: "Num Lock",
  0x02: "Caps Lock",
  0x03: "Scroll Lock",
  0x04: "Compose",
  0x05: "Kana",
  0x06: "Power",
  0x07: "Shift",
  0x09: "Mute",
  0x4b: "Generic Indicator",
};

const CONSUMER_USAGES: Record<number, string> = {
  0x01: "Consumer Control",
  0x02: "Numeric Key Pad",
  0x30: "Power",
  0x34: "Sleep",
  0x40: "Menu",
  0x8a: "Email Reader",
  0x8c: "Cellular Phone",
  0xb0: "Play",
  0xb1: "Pause",
  0xb2: "Record",
  0xb3: "Fast Forward",
  0xb4: "Rewind",
  0xb5: "Scan Next Track",
  0xb6: "Scan Previous Track",
  0xb7: "Stop",
  0xb8: "Eject",
  0xcd: "Play/Pause",
  0xe0: "Volume",
  0xe2: "Mute",
  0xe5: "Bass Boost",
  0xe9: "Volume Increment",
  0xea: "Volume Decrement",
  0x183: "AL Consumer Control Configuration",
  0x18a: "AL Email Reader",
  0x192: "AL Calculator",
  0x194: "AL Local Machine Browser",
  0x196: "AL Internet Browser",
  0x1a6: "AL Integrated Help Center",
  0x201: "AC New",
  0x203: "AC Close",
  0x207: "AC Save",
  0x208: "AC Print",
  0x21a: "AC Undo",
  0x21b: "AC Copy",
  0x21c: "AC Cut",
  0x21d: "AC Paste",
  0x221: "AC Search",
  0x223: "AC Home",
  0x224: "AC Back",
  0x225: "AC Forward",
  0x226: "AC Stop",
  0x227: "AC Refresh",
  0x22a: "AC Bookmarks",
  0x22d: "AC Zoom In",
  0x22e: "AC Zoom Out",
};

const DIGITIZER_USAGES: Record<number, string> = {
  0x01: "Digitizer",
  0x02: "Pen",
  0x04: "Touch Screen",
  0x05: "Touch Pad",
  0x20: "Stylus",
  0x22: "Finger",
  0x30: "Tip Pressure",
  0x31: "Barrel Pressure",
  0x32: "In Range",
  0x33: "Touch",
  0x37: "Data Valid",
  0x38: "Transducer Index",
  0x42: "Tip Switch",
  0x44: "Barrel Switch",
  0x45: "Eraser",
  0x47: "Confidence",
  0x48: "Width",
  0x49: "Height",
  0x51: "Contact Identifier",
  0x54: "Contact Count",
  0x55: "Contact Count Maximum",
};

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/** Human name for a usage page number, including the vendor ranges. */
export function usagePageName(page: number): string {
  const known = USAGE_PAGES[page];
  if (known) return known;
  if (page >= 0xff00 && page <= 0xffff) return `Vendor defined page 0x${hex4(page)}`;
  if (page >= 0x92 && page <= 0xfeff) return `Reserved page 0x${hex4(page)}`;
  return `Usage page 0x${hex4(page)}`;
}

function keyboardUsageName(usage: number): string | undefined {
  if (usage >= 0x04 && usage <= 0x1d) return String.fromCharCode(65 + usage - 0x04);
  if (usage >= 0x1e && usage <= 0x26) return String(usage - 0x1d);
  if (usage === 0x27) return "0";
  if (usage >= 0x3a && usage <= 0x45) return `F${usage - 0x39}`;
  if (usage >= 0x59 && usage <= 0x61) return `Keypad ${usage - 0x58}`;
  return KEYBOARD_USAGES[usage];
}

/** Human name for a usage within a page. Falls back to the hex code. */
export function usageName(page: number, usage: number): string {
  let name: string | undefined;
  switch (page) {
    case 0x01:
      name = GENERIC_DESKTOP_USAGES[usage];
      break;
    case 0x07:
      name = keyboardUsageName(usage);
      break;
    case 0x08:
      name = LED_USAGES[usage];
      break;
    case 0x09:
      name = usage === 0 ? "No button" : `Button ${usage}`;
      break;
    case 0x0a:
      name = usage === 0 ? "Ordinal" : `Instance ${usage}`;
      break;
    case 0x0c:
      name = CONSUMER_USAGES[usage];
      break;
    case 0x0d:
      name = DIGITIZER_USAGES[usage];
      break;
    default:
      name = undefined;
  }
  return name ?? `Usage 0x${hex4(usage)}`;
}

/** "Generic Desktop / Mouse" style label for a page+usage pair. */
export function fullUsageName(page: number, usage: number): string {
  return `${usagePageName(page)} / ${usageName(page, usage)}`;
}

/* ------------------------------------------------------------------ *
 * item tables
 * ------------------------------------------------------------------ */

const MAIN_TAGS: Record<number, string> = {
  0x8: "Input",
  0x9: "Output",
  0xa: "Collection",
  0xb: "Feature",
  0xc: "End Collection",
};

const GLOBAL_TAGS: Record<number, string> = {
  0x0: "Usage Page",
  0x1: "Logical Minimum",
  0x2: "Logical Maximum",
  0x3: "Physical Minimum",
  0x4: "Physical Maximum",
  0x5: "Unit Exponent",
  0x6: "Unit",
  0x7: "Report Size",
  0x8: "Report ID",
  0x9: "Report Count",
  0xa: "Push",
  0xb: "Pop",
};

const LOCAL_TAGS: Record<number, string> = {
  0x0: "Usage",
  0x1: "Usage Minimum",
  0x2: "Usage Maximum",
  0x3: "Designator Index",
  0x4: "Designator Minimum",
  0x5: "Designator Maximum",
  0x7: "String Index",
  0x8: "String Minimum",
  0x9: "String Maximum",
  0xa: "Delimiter",
};

const COLLECTION_TYPES: Record<number, string> = {
  0x00: "Physical",
  0x01: "Application",
  0x02: "Logical",
  0x03: "Report",
  0x04: "Named Array",
  0x05: "Usage Switch",
  0x06: "Usage Modifier",
};

/** Human name for a Collection item's type byte. */
export function collectionTypeName(type: number): string {
  const known = COLLECTION_TYPES[type];
  if (known) return known;
  if (type >= 0x80 && type <= 0xff)
    return `Vendor defined (0x${type.toString(16).toUpperCase().padStart(2, "0")})`;
  return `Reserved (0x${type.toString(16).toUpperCase().padStart(2, "0")})`;
}

/* ------------------------------------------------------------------ *
 * public shapes
 * ------------------------------------------------------------------ */

export type ItemType = "Main" | "Global" | "Local" | "Reserved";

/** One parsed short (or long) item from the descriptor byte stream. */
export interface DescriptorItem {
  /** Byte offset of the item's prefix inside the descriptor. */
  offset: number;
  /** Every byte of the item, prefix included. */
  bytes: number[];
  type: ItemType;
  tag: number;
  tagName: string;
  /** Number of data bytes carried by the item (0, 1, 2 or 4). */
  size: number;
  /** Data bytes read little endian, unsigned. */
  value: number;
  /** Same bytes read little endian, sign extended. */
  signedValue: number;
  /** Collection nesting level, used for the indented tree. */
  depth: number;
  /** Readable one-liner, e.g. "Usage Page (Generic Desktop)". */
  description: string;
}

export type ReportKind = "input" | "output" | "feature";

/** One decodable slice of a report. Variable controls get one each. */
export interface ReportField {
  name: string;
  usagePage: number;
  usagePageName: string;
  usage?: number;
  usageMinimum?: number;
  usageMaximum?: number;
  /** Bit position inside the report payload, report ID byte excluded. */
  bitOffset: number;
  /** Bits per element. */
  bitSize: number;
  /** Elements: 1 for a variable control, N for an array or padding run. */
  count: number;
  logicalMinimum: number;
  logicalMaximum: number;
  isArray: boolean;
  isConstant: boolean;
  isRelative: boolean;
  isSigned: boolean;
}

/** Every field of one report ID in one direction. */
export interface ReportLayout {
  kind: ReportKind;
  /** 0 when the descriptor declares no Report ID at all. */
  reportId: number;
  fields: ReportField[];
  totalBits: number;
  totalBytes: number;
}

export interface ParsedDescriptor {
  items: DescriptorItem[];
  reports: ReportLayout[];
  /** Top level application collections, in declaration order. */
  applications: { usagePage: number; usage: number; name: string }[];
  /** True when at least one Report ID item was seen. */
  usesReportIds: boolean;
  byteLength: number;
}

/* ------------------------------------------------------------------ *
 * descriptor parsing
 * ------------------------------------------------------------------ */

const SIZE_TABLE = [0, 1, 2, 4];

function readUnsigned(bytes: number[]): number {
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value += (bytes[i] as number) * 2 ** (8 * i);
  }
  return value;
}

function signExtend(value: number, bits: number): number {
  if (bits <= 0 || bits >= 53) return value;
  const half = 2 ** (bits - 1);
  return value >= half ? value - 2 ** bits : value;
}

function readSigned(bytes: number[]): number {
  return signExtend(readUnsigned(bytes), bytes.length * 8);
}

interface GlobalState {
  usagePage: number;
  logicalMinimum: number;
  logicalMaximum: number;
  physicalMinimum: number;
  physicalMaximum: number;
  reportSize: number;
  reportCount: number;
  reportId: number;
}

function freshGlobals(): GlobalState {
  return {
    usagePage: 0,
    logicalMinimum: 0,
    logicalMaximum: 0,
    physicalMinimum: 0,
    physicalMaximum: 0,
    reportSize: 0,
    reportCount: 0,
    reportId: 0,
  };
}

type LocalUsage =
  | { kind: "usage"; page: number; id: number }
  | { kind: "range"; page: number; min: number; max: number };

interface LocalState {
  usages: LocalUsage[];
  pendingMinimum?: { page: number; id: number };
  usageMinimum?: { page: number; id: number };
  usageMaximum?: { page: number; id: number };
}

function freshLocals(): LocalState {
  return { usages: [] };
}

/** Splits a 32 bit extended usage, or pairs a 16 bit one with the current page. */
function resolveUsage(value: number, size: number, page: number): { page: number; id: number } {
  const high = (value >>> 16) & 0xffff;
  if (size === 4 && high !== 0) return { page: high, id: value & 0xffff };
  return { page, id: value & 0xffff };
}

function mainFlagNames(value: number, allowVolatile: boolean): string[] {
  const flags = [
    value & 0x01 ? "Constant" : "Data",
    value & 0x02 ? "Variable" : "Array",
    value & 0x04 ? "Relative" : "Absolute",
  ];
  if (value & 0x08) flags.push("Wrap");
  if (value & 0x10) flags.push("Non Linear");
  if (value & 0x20) flags.push("No Preferred State");
  if (value & 0x40) flags.push("Null State");
  if (allowVolatile && value & 0x80) flags.push("Volatile");
  if (value & 0x100) flags.push("Buffered Bytes");
  return flags;
}

const TRUNCATED_FIX =
  "The descriptor is cut short. Paste the complete byte dump, including every data byte the last item declares.";

interface LayoutBuilder {
  layouts: Map<string, ReportLayout>;
  order: string[];
}

function layoutFor(builder: LayoutBuilder, kind: ReportKind, reportId: number): ReportLayout {
  const key = `${kind}:${reportId}`;
  const existing = builder.layouts.get(key);
  if (existing) return existing;
  const created: ReportLayout = { kind, reportId, fields: [], totalBits: 0, totalBytes: 0 };
  builder.layouts.set(key, created);
  builder.order.push(key);
  return created;
}

function orderedLayouts(builder: LayoutBuilder): ReportLayout[] {
  return builder.order.map((key) => builder.layouts.get(key) as ReportLayout);
}

/** Expands the local usage list to exactly `count` entries, repeating the last. */
function resolveUsageList(
  locals: LocalState,
  count: number,
): ({ page: number; id: number } | undefined)[] {
  const out: ({ page: number; id: number } | undefined)[] = [];
  for (const entry of locals.usages) {
    if (out.length >= count) break;
    if (entry.kind === "usage") {
      out.push({ page: entry.page, id: entry.id });
    } else {
      for (let id = entry.min; id <= entry.max && out.length < count; id++) {
        out.push({ page: entry.page, id });
      }
    }
  }
  const last = out.length ? out[out.length - 1] : undefined;
  while (out.length < count) out.push(last);
  return out;
}

function pushMainFields(
  builder: LayoutBuilder,
  kind: ReportKind,
  flags: number,
  globals: GlobalState,
  locals: LocalState,
): void {
  const bitSize = globals.reportSize;
  const count = globals.reportCount;
  if (bitSize <= 0 || count <= 0) return;

  const layout = layoutFor(builder, kind, globals.reportId);
  const start = layout.totalBits;
  const isConstant = (flags & 0x01) !== 0;
  const isVariable = (flags & 0x02) !== 0;
  const isRelative = (flags & 0x04) !== 0;
  const isSigned = globals.logicalMinimum < 0;
  const page = globals.usagePage;

  const base = {
    logicalMinimum: globals.logicalMinimum,
    logicalMaximum: globals.logicalMaximum,
    isConstant,
    isRelative,
    isSigned,
  };

  if (isConstant) {
    layout.fields.push({
      ...base,
      name: "Padding",
      usagePage: page,
      usagePageName: usagePageName(page),
      bitOffset: start,
      bitSize,
      count,
      isArray: !isVariable,
    });
  } else if (isVariable) {
    const usages = resolveUsageList(locals, count);
    for (let i = 0; i < count; i++) {
      const u = usages[i];
      const fieldPage = u ? u.page : page;
      layout.fields.push({
        ...base,
        name: u ? usageName(fieldPage, u.id) : `Unnamed field ${i + 1}`,
        usagePage: fieldPage,
        usagePageName: usagePageName(fieldPage),
        usage: u?.id,
        bitOffset: start + i * bitSize,
        bitSize,
        count: 1,
        isArray: false,
      });
    }
  } else {
    const min = locals.usageMinimum;
    const max = locals.usageMaximum;
    const arrayPage = min?.page ?? page;
    layout.fields.push({
      ...base,
      name: `${usagePageName(arrayPage)} array`,
      usagePage: arrayPage,
      usagePageName: usagePageName(arrayPage),
      usageMinimum: min?.id,
      usageMaximum: max?.id,
      bitOffset: start,
      bitSize,
      count,
      isArray: true,
    });
  }

  layout.totalBits = start + bitSize * count;
  layout.totalBytes = Math.ceil(layout.totalBits / 8);
}

/**
 * Parses a raw HID report descriptor into its item stream, a nesting depth
 * per item, and the computed per report field layout.
 *
 * Throws ToolError('truncated-descriptor') when an item declares more data
 * bytes than the descriptor actually contains.
 */
export function parseReportDescriptor(bytes: Uint8Array): ParsedDescriptor {
  const items: DescriptorItem[] = [];
  const applications: ParsedDescriptor["applications"] = [];
  const builder: LayoutBuilder = { layouts: new Map(), order: [] };

  let globals = freshGlobals();
  const globalStack: GlobalState[] = [];
  let locals = freshLocals();
  let depth = 0;
  let usesReportIds = false;

  let i = 0;
  while (i < bytes.length) {
    const offset = i;
    const prefix = bytes[i] as number;
    i += 1;

    // Long item: 0xFE prefix, then a length byte and a tag byte.
    if (prefix === 0xfe) {
      if (i + 1 >= bytes.length) {
        throw new ToolError(
          "truncated-descriptor",
          `The long item at offset ${offset} is missing its length and tag bytes.`,
          TRUNCATED_FIX,
        );
      }
      const dataSize = bytes[i] as number;
      const longTag = bytes[i + 1] as number;
      const end = i + 2 + dataSize;
      if (end > bytes.length) {
        throw new ToolError(
          "truncated-descriptor",
          `The long item at offset ${offset} declares ${dataSize} data bytes but only ${bytes.length - (i + 2)} remain.`,
          TRUNCATED_FIX,
        );
      }
      items.push({
        offset,
        bytes: Array.from(bytes.subarray(offset, end)),
        type: "Reserved",
        tag: 0xf,
        tagName: "Long Item",
        size: dataSize,
        value: 0,
        signedValue: 0,
        depth,
        description: `Long Item (tag 0x${longTag.toString(16).toUpperCase().padStart(2, "0")}, ${dataSize} data bytes)`,
      });
      i = end;
      continue;
    }

    const sizeCode = prefix & 0x03;
    const typeCode = (prefix >> 2) & 0x03;
    const tag = (prefix >> 4) & 0x0f;
    const size = SIZE_TABLE[sizeCode] as number;
    const end = i + size;
    if (end > bytes.length) {
      throw new ToolError(
        "truncated-descriptor",
        `The item at offset ${offset} declares ${size} data bytes but only ${bytes.length - i} remain.`,
        TRUNCATED_FIX,
      );
    }

    const dataBytes = Array.from(bytes.subarray(i, end));
    const value = readUnsigned(dataBytes);
    const signedValue = readSigned(dataBytes);
    i = end;

    const type: ItemType = (["Main", "Global", "Local", "Reserved"] as const)[typeCode] as ItemType;
    let tagName: string;
    let description: string;
    let itemDepth = depth;

    if (type === "Main") {
      tagName = MAIN_TAGS[tag] ?? `Reserved main tag ${tag}`;
      if (tag === 0x8 || tag === 0x9 || tag === 0xb) {
        const kind: ReportKind = tag === 0x8 ? "input" : tag === 0x9 ? "output" : "feature";
        description = `${tagName} (${mainFlagNames(value, tag !== 0x8).join(", ")})`;
        pushMainFields(builder, kind, value, globals, locals);
      } else if (tag === 0xa) {
        description = `Collection (${collectionTypeName(value)})`;
        if (value === 0x01) {
          const first = locals.usages.find((u) => u.kind === "usage");
          const page = first && first.kind === "usage" ? first.page : globals.usagePage;
          const id = first && first.kind === "usage" ? first.id : 0;
          applications.push({ usagePage: page, usage: id, name: fullUsageName(page, id) });
        }
        depth += 1;
      } else if (tag === 0xc) {
        depth = Math.max(0, depth - 1);
        itemDepth = depth;
        description = "End Collection";
      } else {
        description = `${tagName} (0x${value.toString(16).toUpperCase()})`;
      }
      locals = freshLocals();
    } else if (type === "Global") {
      tagName = GLOBAL_TAGS[tag] ?? `Reserved global tag ${tag}`;
      switch (tag) {
        case 0x0:
          globals.usagePage = value;
          description = `Usage Page (${usagePageName(value)})`;
          break;
        case 0x1:
          globals.logicalMinimum = signedValue;
          description = `Logical Minimum (${signedValue})`;
          break;
        case 0x2:
          // Signed only when the minimum was negative (the convention every
          // real stack uses, because 0x26 FF 00 means 255 and not -1).
          globals.logicalMaximum = globals.logicalMinimum < 0 ? signedValue : value;
          description = `Logical Maximum (${globals.logicalMaximum})`;
          break;
        case 0x3:
          globals.physicalMinimum = signedValue;
          description = `Physical Minimum (${signedValue})`;
          break;
        case 0x4:
          globals.physicalMaximum = globals.physicalMinimum < 0 ? signedValue : value;
          description = `Physical Maximum (${globals.physicalMaximum})`;
          break;
        case 0x5:
          description = `Unit Exponent (${signedValue})`;
          break;
        case 0x6:
          description = `Unit (0x${value.toString(16).toUpperCase()})`;
          break;
        case 0x7:
          globals.reportSize = value;
          description = `Report Size (${value})`;
          break;
        case 0x8:
          globals.reportId = value;
          usesReportIds = true;
          description = `Report ID (${value})`;
          break;
        case 0x9:
          globals.reportCount = value;
          description = `Report Count (${value})`;
          break;
        case 0xa:
          globalStack.push({ ...globals });
          description = "Push";
          break;
        case 0xb: {
          const popped = globalStack.pop();
          if (popped) globals = popped;
          description = "Pop";
          break;
        }
        default:
          description = `${tagName} (${value})`;
      }
    } else if (type === "Local") {
      tagName = LOCAL_TAGS[tag] ?? `Reserved local tag ${tag}`;
      switch (tag) {
        case 0x0: {
          const u = resolveUsage(value, size, globals.usagePage);
          locals.usages.push({ kind: "usage", page: u.page, id: u.id });
          description = `Usage (${usageName(u.page, u.id)})`;
          break;
        }
        case 0x1: {
          const u = resolveUsage(value, size, globals.usagePage);
          locals.pendingMinimum = u;
          locals.usageMinimum = u;
          description = `Usage Minimum (${usageName(u.page, u.id)})`;
          break;
        }
        case 0x2: {
          const u = resolveUsage(value, size, globals.usagePage);
          locals.usageMaximum = u;
          const min = locals.pendingMinimum;
          if (min && u.id >= min.id) {
            locals.usages.push({ kind: "range", page: min.page, min: min.id, max: u.id });
          }
          locals.pendingMinimum = undefined;
          description = `Usage Maximum (${usageName(u.page, u.id)})`;
          break;
        }
        case 0xa:
          description = `Delimiter (${value === 1 ? "open" : "close"})`;
          break;
        default:
          description = `${tagName} (${value})`;
      }
    } else {
      tagName = `Reserved tag ${tag}`;
      description = `Reserved (type 3, tag ${tag}, ${size} data bytes)`;
    }

    items.push({
      offset,
      bytes: Array.from(bytes.subarray(offset, end)),
      type,
      tag,
      tagName,
      size,
      value,
      signedValue,
      depth: itemDepth,
      description,
    });
  }

  return {
    items,
    reports: orderedLayouts(builder),
    applications,
    usesReportIds,
    byteLength: bytes.length,
  };
}

/* ------------------------------------------------------------------ *
 * WebHID collections to the same layout shape
 * ------------------------------------------------------------------ */

/** Subset of WebHID's HIDReportItem that this tool reads. */
export interface HidReportItemInfo {
  isAbsolute?: boolean;
  isArray?: boolean;
  isConstant?: boolean;
  isRange?: boolean;
  /** 32 bit extended usages: page in the high half, usage in the low half. */
  usages?: number[];
  usageMinimum?: number;
  usageMaximum?: number;
  reportSize?: number;
  reportCount?: number;
  logicalMinimum?: number;
  logicalMaximum?: number;
}

export interface HidReportInfo {
  reportId?: number;
  items?: HidReportItemInfo[];
}

/** Subset of WebHID's HIDCollectionInfo that this tool reads. */
export interface HidCollectionInfo {
  usagePage?: number;
  usage?: number;
  type?: number;
  children?: HidCollectionInfo[];
  inputReports?: HidReportInfo[];
  outputReports?: HidReportInfo[];
  featureReports?: HidReportInfo[];
}

function splitExtendedUsage(value: number, fallbackPage: number): { page: number; id: number } {
  const page = (value >>> 16) & 0xffff;
  if (page === 0) return { page: fallbackPage, id: value & 0xffff };
  return { page, id: value & 0xffff };
}

function pushCollectionItemFields(
  builder: LayoutBuilder,
  kind: ReportKind,
  reportId: number,
  item: HidReportItemInfo,
  fallbackPage: number,
): void {
  const bitSize = item.reportSize ?? 0;
  const count = item.reportCount ?? 0;
  if (bitSize <= 0 || count <= 0) return;

  const layout = layoutFor(builder, kind, reportId);
  const start = layout.totalBits;
  const logicalMinimum = item.logicalMinimum ?? 0;
  const logicalMaximum = item.logicalMaximum ?? 0;
  const base = {
    logicalMinimum,
    logicalMaximum,
    isConstant: item.isConstant === true,
    isRelative: item.isAbsolute === false,
    isSigned: logicalMinimum < 0,
  };

  if (item.isConstant) {
    layout.fields.push({
      ...base,
      name: "Padding",
      usagePage: fallbackPage,
      usagePageName: usagePageName(fallbackPage),
      bitOffset: start,
      bitSize,
      count,
      isArray: item.isArray === true,
    });
  } else if (item.isArray) {
    const min =
      item.usageMinimum !== undefined
        ? splitExtendedUsage(item.usageMinimum, fallbackPage)
        : undefined;
    const max =
      item.usageMaximum !== undefined
        ? splitExtendedUsage(item.usageMaximum, fallbackPage)
        : undefined;
    const page = min?.page ?? fallbackPage;
    layout.fields.push({
      ...base,
      name: `${usagePageName(page)} array`,
      usagePage: page,
      usagePageName: usagePageName(page),
      usageMinimum: min?.id,
      usageMaximum: max?.id,
      bitOffset: start,
      bitSize,
      count,
      isArray: true,
    });
  } else {
    const list: { page: number; id: number }[] = [];
    if (item.isRange && item.usageMinimum !== undefined && item.usageMaximum !== undefined) {
      const min = splitExtendedUsage(item.usageMinimum, fallbackPage);
      const max = splitExtendedUsage(item.usageMaximum, fallbackPage);
      for (let id = min.id; id <= max.id && list.length < count; id++)
        list.push({ page: min.page, id });
    }
    for (const raw of item.usages ?? []) {
      if (list.length >= count) break;
      list.push(splitExtendedUsage(raw, fallbackPage));
    }
    for (let i = 0; i < count; i++) {
      const u = list[i] ?? list[list.length - 1];
      const page = u ? u.page : fallbackPage;
      layout.fields.push({
        ...base,
        name: u ? usageName(page, u.id) : `Unnamed field ${i + 1}`,
        usagePage: page,
        usagePageName: usagePageName(page),
        usage: u?.id,
        bitOffset: start + i * bitSize,
        bitSize,
        count: 1,
        isArray: false,
      });
    }
  }

  layout.totalBits = start + bitSize * count;
  layout.totalBytes = Math.ceil(layout.totalBits / 8);
}

function walkCollection(builder: LayoutBuilder, collection: HidCollectionInfo): void {
  const page = collection.usagePage ?? 0;
  const groups: [ReportKind, HidReportInfo[] | undefined][] = [
    ["input", collection.inputReports],
    ["output", collection.outputReports],
    ["feature", collection.featureReports],
  ];
  for (const [kind, reports] of groups) {
    for (const report of reports ?? []) {
      const reportId = report.reportId ?? 0;
      for (const item of report.items ?? []) {
        pushCollectionItemFields(builder, kind, reportId, item, page);
      }
    }
  }
  for (const child of collection.children ?? []) walkCollection(builder, child);
}

/**
 * Builds report layouts from WebHID's parsed collection tree.
 *
 * WebHID hands the page the collections the browser already parsed, never
 * the raw descriptor bytes, so this is the only layout available from a
 * live device.
 */
export function layoutsFromCollections(collections: HidCollectionInfo[]): ReportLayout[] {
  const builder: LayoutBuilder = { layouts: new Map(), order: [] };
  for (const collection of collections) walkCollection(builder, collection);
  return orderedLayouts(builder);
}

/** The layout of one WebHID report on its own, used by the tree renderer. */
export function layoutFromReport(
  kind: ReportKind,
  report: HidReportInfo,
  fallbackPage: number,
): ReportLayout {
  const builder: LayoutBuilder = { layouts: new Map(), order: [] };
  const reportId = report.reportId ?? 0;
  for (const item of report.items ?? []) {
    pushCollectionItemFields(builder, kind, reportId, item, fallbackPage);
  }
  return orderedLayouts(builder)[0] ?? { kind, reportId, fields: [], totalBits: 0, totalBytes: 0 };
}

/* ------------------------------------------------------------------ *
 * report decoding
 * ------------------------------------------------------------------ */

export interface DecodedField {
  name: string;
  usagePage: number;
  usagePageName: string;
  usage?: number;
  bitOffset: number;
  bitSize: number;
  count: number;
  isArray: boolean;
  isConstant: boolean;
  isRelative: boolean;
  logicalMinimum: number;
  logicalMaximum: number;
  /** Variable and padding fields: the decoded number. */
  value?: number;
  /** Array fields: the non zero usage codes present in the report. */
  values?: number[];
  /** Array fields: those codes named. */
  names?: string[];
  /** Ready to render text, e.g. "-12", "1 (on)" or "A, B". */
  display: string;
}

/** Reads `bitSize` bits starting at `bitOffset`, LSB first, little endian. */
export function extractBits(data: Uint8Array, bitOffset: number, bitSize: number): number {
  let value = 0;
  for (let i = 0; i < bitSize && i < 53; i++) {
    const bit = bitOffset + i;
    const byte = data[bit >> 3] ?? 0;
    if ((byte >> (bit & 7)) & 1) value += 2 ** i;
  }
  return value;
}

function displayValue(field: ReportField, value: number): string {
  if (field.logicalMinimum === 0 && field.logicalMaximum === 1) {
    return `${value} (${value ? "on" : "off"})`;
  }
  return String(value);
}

/**
 * Decodes one report payload against a layout.
 *
 * `data` is the payload with the report ID byte already removed, which is
 * exactly what WebHID's inputreport event hands over in `event.data`.
 * Missing trailing bytes read as zero so a short report still decodes.
 */
export function decodeInputReport(layout: ReportLayout, data: Uint8Array): DecodedField[] {
  return layout.fields.map((field) => {
    const common = {
      name: field.name,
      usagePage: field.usagePage,
      usagePageName: field.usagePageName,
      usage: field.usage,
      bitOffset: field.bitOffset,
      bitSize: field.bitSize,
      count: field.count,
      isArray: field.isArray,
      isConstant: field.isConstant,
      isRelative: field.isRelative,
      logicalMinimum: field.logicalMinimum,
      logicalMaximum: field.logicalMaximum,
    };

    if (field.isArray && !field.isConstant) {
      const values: number[] = [];
      for (let i = 0; i < field.count; i++) {
        const raw = extractBits(data, field.bitOffset + i * field.bitSize, field.bitSize);
        if (raw !== 0) values.push(raw);
      }
      const names = values.map((code) => usageName(field.usagePage, code));
      return { ...common, values, names, display: names.length ? names.join(", ") : "(none)" };
    }

    if (field.count > 1) {
      // A padding run: report the whole span as one raw number when it fits.
      const totalBits = field.bitSize * field.count;
      const raw = extractBits(data, field.bitOffset, Math.min(totalBits, 32));
      return { ...common, value: raw, display: String(raw) };
    }

    const raw = extractBits(data, field.bitOffset, field.bitSize);
    const value = field.isSigned ? signExtend(raw, field.bitSize) : raw;
    return { ...common, value, display: displayValue(field, value) };
  });
}

/* ------------------------------------------------------------------ *
 * formatting
 * ------------------------------------------------------------------ */

function lsbFirstBits(byte: number): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += (byte >> i) & 1;
  return out;
}

/**
 * Grouped hex plus a bit ruler underneath. Bits read left to right in the
 * order HID packs them (bit 0 first), so a field's bit offset can be counted
 * straight off the line.
 */
export function formatReportHex(data: Uint8Array): string {
  if (data.length === 0) return "(empty report)";
  const lines: string[] = [];
  for (let start = 0; start < data.length; start += 8) {
    const chunk = data.subarray(start, Math.min(start + 8, data.length));
    const hexLine = Array.from(chunk, (b) =>
      b.toString(16).toUpperCase().padStart(2, "0").padEnd(8),
    ).join(" ");
    const bitLine = Array.from(chunk, lsbFirstBits).join(" ");
    lines.push(`${hex4(start)}  ${hexLine.trimEnd()}`);
    lines.push(`      ${bitLine}`);
  }
  return lines.join("\n");
}

/** One aligned line describing a field's position, size and range. */
export function formatFieldLine(field: ReportField): string {
  const position = `bit ${field.bitOffset}`.padEnd(10);
  const size = (
    field.count > 1 ? `${field.bitSize}x${field.count} bits` : `${field.bitSize} bits`
  ).padEnd(12);
  const name = field.name.padEnd(26);
  const range = `logical ${field.logicalMinimum}..${field.logicalMaximum}`;
  const flags: string[] = [];
  if (field.isArray) flags.push("array");
  if (field.isRelative) flags.push("relative");
  if (field.isConstant) flags.push("constant");
  if (field.isSigned) flags.push("signed");
  return `${position}${size}${name}${range}${flags.length ? `  [${flags.join(", ")}]` : ""}`.trimEnd();
}

const KIND_LABELS: Record<ReportKind, string> = {
  input: "Input",
  output: "Output",
  feature: "Feature",
};

/** Header line for one report layout, e.g. "Input report, ID 3, 4 bytes". */
export function formatLayoutHeader(layout: ReportLayout): string {
  const id = layout.reportId === 0 ? "no report ID" : `ID ${layout.reportId}`;
  return `${KIND_LABELS[layout.kind]} report, ${id}, ${layout.totalBytes} bytes (${layout.totalBits} bits)`;
}

/** The whole computed layout as an indented text block. */
export function formatReportLayouts(layouts: ReportLayout[]): string {
  if (layouts.length === 0) return "No input, output or feature reports were declared.";
  const blocks = layouts.map((layout) => {
    const lines = [
      formatLayoutHeader(layout),
      ...layout.fields.map((f) => `  ${formatFieldLine(f)}`),
    ];
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/** The item stream as an indented tree, optionally with the raw bytes. */
export function formatDescriptorTree(items: DescriptorItem[], showBytes = true): string {
  if (items.length === 0) return "The descriptor contains no items.";
  return items
    .map((item) => {
      const indent = "  ".repeat(item.depth);
      if (!showBytes) return `${indent}${item.description}`;
      const raw = item.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
      return `${raw.padEnd(15)}${indent}${item.description}`;
    })
    .join("\n");
}

/**
 * Renders a WebHID collection tree, since a live device only ever exposes
 * this and never the descriptor bytes it was built from.
 */
export function describeCollectionTree(collections: HidCollectionInfo[]): string {
  const lines: string[] = [];

  const walk = (collection: HidCollectionInfo, depth: number) => {
    const indent = "  ".repeat(depth);
    const page = collection.usagePage ?? 0;
    const usage = collection.usage ?? 0;
    lines.push(
      `${indent}${collectionTypeName(collection.type ?? 0)} collection: ${fullUsageName(page, usage)}`,
    );

    const groups: [ReportKind, HidReportInfo[] | undefined][] = [
      ["input", collection.inputReports],
      ["output", collection.outputReports],
      ["feature", collection.featureReports],
    ];
    for (const [kind, reports] of groups) {
      for (const report of reports ?? []) {
        const reportId = report.reportId ?? 0;
        const id = reportId === 0 ? "no report ID" : `ID ${reportId}`;
        const layout = layoutFromReport(kind, report, page);
        lines.push(`${indent}  ${KIND_LABELS[kind]} report, ${id}, ${layout.totalBytes} bytes`);
        for (const field of layout.fields) lines.push(`${indent}    ${formatFieldLine(field)}`);
      }
    }

    for (const child of collection.children ?? []) walk(child, depth + 1);
  };

  for (const collection of collections) walk(collection, 0);
  return lines.length ? lines.join("\n") : "The device reported no collections.";
}

/* ------------------------------------------------------------------ *
 * hex input parsing
 * ------------------------------------------------------------------ */

const HEX_FIX =
  'Paste the descriptor as hex bytes. Spaces, commas, newlines, 0x prefixes and C style comments are all fine, for example "05 01 09 02 A1 01" or "0x05, 0x01, 0x09, 0x02".';

/**
 * Reads a descriptor dump in whatever shape it was copied from: spaced hex,
 * comma separated, a C array with 0x prefixes and comments, or one unbroken
 * hex string.
 */
export function parseHexBytes(text: string): Uint8Array {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  // A C or Rust array literal: keep only what is between the braces so the
  // declaration ("static const uint8_t desc[] =") never reaches the tokenizer.
  const open = withoutComments.indexOf("{");
  const close = withoutComments.lastIndexOf("}");
  const body =
    open !== -1 && close > open ? withoutComments.slice(open + 1, close) : withoutComments;

  const stripped = body
    // Offset columns from hexdump style output, e.g. "0000: 05 01".
    .replace(/^[ \t]*[0-9a-fA-F]{4,8}:[ \t]*/gm, "")
    .replace(/[{}[\]();]/g, " ")
    .replace(/\\x/gi, " ")
    .replace(/0x/gi, " ")
    .replace(/[,:]/g, " ");

  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new ToolError("no-bytes", "No hex bytes were found in the input.", HEX_FIX);
  }

  const bytes: number[] = [];
  for (const token of tokens) {
    if (!/^[0-9a-fA-F]+$/.test(token)) {
      throw new ToolError("invalid-hex", `"${token}" is not a hex byte.`, HEX_FIX);
    }
    if (token.length <= 2) {
      bytes.push(parseInt(token, 16));
      continue;
    }
    if (token.length % 2 !== 0) {
      throw new ToolError(
        "invalid-hex",
        `"${token}" has an odd number of hex digits, so it cannot be split into whole bytes.`,
        HEX_FIX,
      );
    }
    for (let i = 0; i < token.length; i += 2) bytes.push(parseInt(token.slice(i, i + 2), 16));
  }

  return Uint8Array.from(bytes);
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface HidOpts {
  /** Which sections to include in the output. */
  view?: "both" | "tree" | "layout";
  /** Print each item's raw bytes beside the tree. */
  showBytes?: boolean;
  [key: string]: unknown;
}

const NO_INPUT_ROWS: Record<string, string> = {
  "Live capture":
    "Click Connect a device in the panel above, pick a device from the browser prompt, and every report it sends is decoded here field by field.",
  "Browser support":
    "Live capture needs WebHID, which only Chromium browsers ship on desktop today. Chrome, Edge, Brave, Arc and Opera work. Firefox and Safari do not.",
  "Blocked devices":
    "Keyboards and other devices on protected usage pages are hidden from the device chooser by the browser itself, so they cannot be captured here.",
  "No device handy":
    'Paste a report descriptor hex dump instead. Bytes like "05 01 09 02 A1 01" or a C array with 0x prefixes both work, and the full item tree plus the computed report layout comes back.',
  Privacy: "Everything is parsed in this tab: your files and inputs never leave your device.",
};

/**
 * With no input, explains what the panel does and how to use the paste path.
 * With a hex dump, parses it into an item tree and a report layout.
 */
export function run(input: string | Uint8Array, opts: HidOpts = {}): Record<string, string> {
  const bytes =
    input instanceof Uint8Array
      ? input
      : typeof input === "string" && input.trim()
        ? parseHexBytes(input)
        : null;

  if (bytes === null) return { ...NO_INPUT_ROWS };

  if (bytes.length === 0) {
    throw new ToolError("no-bytes", "No hex bytes were found in the input.", HEX_FIX);
  }

  const parsed = parseReportDescriptor(bytes);
  const view = opts.view ?? "both";
  const showBytes = opts.showBytes ?? true;

  const apps = parsed.applications.length
    ? parsed.applications.map((a) => a.name).join(", ")
    : "none declared";
  const out: Record<string, string> = {
    Summary: `${parsed.byteLength} bytes, ${parsed.items.length} items, ${parsed.reports.length} report layouts. Application collections: ${apps}. Report IDs: ${parsed.usesReportIds ? "yes" : "no"}.`,
  };

  if (view !== "layout") out["Descriptor tree"] = formatDescriptorTree(parsed.items, showBytes);
  if (view !== "tree") out["Report layout"] = formatReportLayouts(parsed.reports);

  return out;
}

export default { run } satisfies ToolLogic<string | Uint8Array, Record<string, string>, HidOpts>;
