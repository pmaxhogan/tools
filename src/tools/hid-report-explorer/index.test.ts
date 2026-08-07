import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  decodeInputReport,
  describeCollectionTree,
  extractBits,
  formatDescriptorTree,
  formatReportHex,
  formatReportLayouts,
  layoutsFromCollections,
  parseHexBytes,
  parseReportDescriptor,
  run,
  usageName,
  usagePageName,
  type HidCollectionInfo,
  type ReportLayout,
} from "./index";

/* ------------------------------------------------------------------ *
 * hand built descriptors
 * ------------------------------------------------------------------ */

/** The classic boot mouse: 3 buttons, 5 bits of padding, relative X and Y. */
const BOOT_MOUSE = Uint8Array.from([
  0x05,
  0x01, // Usage Page (Generic Desktop)
  0x09,
  0x02, // Usage (Mouse)
  0xa1,
  0x01, // Collection (Application)
  0x09,
  0x01, //   Usage (Pointer)
  0xa1,
  0x00, //   Collection (Physical)
  0x05,
  0x09, //     Usage Page (Button)
  0x19,
  0x01, //     Usage Minimum (Button 1)
  0x29,
  0x03, //     Usage Maximum (Button 3)
  0x15,
  0x00, //     Logical Minimum (0)
  0x25,
  0x01, //     Logical Maximum (1)
  0x95,
  0x03, //     Report Count (3)
  0x75,
  0x01, //     Report Size (1)
  0x81,
  0x02, //     Input (Data, Variable, Absolute)
  0x95,
  0x01, //     Report Count (1)
  0x75,
  0x05, //     Report Size (5)
  0x81,
  0x03, //     Input (Constant, Variable, Absolute)
  0x05,
  0x01, //     Usage Page (Generic Desktop)
  0x09,
  0x30, //     Usage (X)
  0x09,
  0x31, //     Usage (Y)
  0x15,
  0x81, //     Logical Minimum (-127)
  0x25,
  0x7f, //     Logical Maximum (127)
  0x75,
  0x08, //     Report Size (8)
  0x95,
  0x02, //     Report Count (2)
  0x81,
  0x06, //     Input (Data, Variable, Relative)
  0xc0, //   End Collection
  0xc0, // End Collection
]);

/** The boot keyboard: modifier bits, reserved byte, LED output, 6 key array. */
const BOOT_KEYBOARD = Uint8Array.from([
  0x05,
  0x01, // Usage Page (Generic Desktop)
  0x09,
  0x06, // Usage (Keyboard)
  0xa1,
  0x01, // Collection (Application)
  0x05,
  0x07, //   Usage Page (Keyboard/Keypad)
  0x19,
  0xe0, //   Usage Minimum (Left Control)
  0x29,
  0xe7, //   Usage Maximum (Right GUI)
  0x15,
  0x00, //   Logical Minimum (0)
  0x25,
  0x01, //   Logical Maximum (1)
  0x75,
  0x01, //   Report Size (1)
  0x95,
  0x08, //   Report Count (8)
  0x81,
  0x02, //   Input (Data, Variable, Absolute)
  0x95,
  0x01, //   Report Count (1)
  0x75,
  0x08, //   Report Size (8)
  0x81,
  0x03, //   Input (Constant, Variable, Absolute)
  0x95,
  0x05, //   Report Count (5)
  0x75,
  0x01, //   Report Size (1)
  0x05,
  0x08, //   Usage Page (LED)
  0x19,
  0x01, //   Usage Minimum (Num Lock)
  0x29,
  0x05, //   Usage Maximum (Kana)
  0x91,
  0x02, //   Output (Data, Variable, Absolute)
  0x95,
  0x01, //   Report Count (1)
  0x75,
  0x03, //   Report Size (3)
  0x91,
  0x03, //   Output (Constant, Variable, Absolute)
  0x95,
  0x06, //   Report Count (6)
  0x75,
  0x08, //   Report Size (8)
  0x15,
  0x00, //   Logical Minimum (0)
  0x25,
  0x65, //   Logical Maximum (101)
  0x05,
  0x07, //   Usage Page (Keyboard/Keypad)
  0x19,
  0x00, //   Usage Minimum (No event)
  0x29,
  0x65, //   Usage Maximum (Application)
  0x81,
  0x00, //   Input (Data, Array, Absolute)
  0xc0, // End Collection
]);

/** A gamepad with a report ID and two 12 bit axes that cross byte edges. */
const GAMEPAD = Uint8Array.from([
  0x05,
  0x01, // Usage Page (Generic Desktop)
  0x09,
  0x05, // Usage (Game Pad)
  0xa1,
  0x01, // Collection (Application)
  0x85,
  0x03, //   Report ID (3)
  0x09,
  0x30, //   Usage (X)
  0x09,
  0x31, //   Usage (Y)
  0x16,
  0x00,
  0xf8, //   Logical Minimum (-2048)
  0x26,
  0xff,
  0x07, //   Logical Maximum (2047)
  0x75,
  0x0c, //   Report Size (12)
  0x95,
  0x02, //   Report Count (2)
  0x81,
  0x02, //   Input (Data, Variable, Absolute)
  0x05,
  0x09, //   Usage Page (Button)
  0x19,
  0x01, //   Usage Minimum (Button 1)
  0x29,
  0x08, //   Usage Maximum (Button 8)
  0x15,
  0x00, //   Logical Minimum (0)
  0x25,
  0x01, //   Logical Maximum (1)
  0x75,
  0x01, //   Report Size (1)
  0x95,
  0x08, //   Report Count (8)
  0x81,
  0x02, //   Input (Data, Variable, Absolute)
  0xc0, // End Collection
]);

function fieldSummary(layout: ReportLayout) {
  return layout.fields.map((f) => [f.name, f.bitOffset, f.bitSize, f.count]);
}

function inputLayout(bytes: Uint8Array, reportId = 0): ReportLayout {
  const parsed = parseReportDescriptor(bytes);
  const found = parsed.reports.find((r) => r.kind === "input" && r.reportId === reportId);
  if (!found) throw new Error(`no input layout for report ${reportId}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * usage tables
 * ------------------------------------------------------------------ */

describe("usage tables", () => {
  it("names the curated pages", () => {
    expect(usagePageName(0x01)).toBe("Generic Desktop");
    expect(usagePageName(0x07)).toBe("Keyboard/Keypad");
    expect(usagePageName(0x09)).toBe("Button");
    expect(usagePageName(0x0c)).toBe("Consumer");
  });

  it("names vendor defined pages by range", () => {
    expect(usagePageName(0xff00)).toBe("Vendor defined page 0xFF00");
    expect(usagePageName(0xffa0)).toBe("Vendor defined page 0xFFA0");
  });

  it("names generic desktop, keyboard, LED and consumer usages", () => {
    expect(usageName(0x01, 0x30)).toBe("X");
    expect(usageName(0x01, 0x38)).toBe("Wheel");
    expect(usageName(0x07, 0x04)).toBe("A");
    expect(usageName(0x07, 0x28)).toBe("Enter");
    expect(usageName(0x07, 0x3a)).toBe("F1");
    expect(usageName(0x07, 0xe1)).toBe("Left Shift");
    expect(usageName(0x08, 0x02)).toBe("Caps Lock");
    expect(usageName(0x09, 7)).toBe("Button 7");
    expect(usageName(0x0c, 0xe9)).toBe("Volume Increment");
  });

  it("falls back to the hex code for unknown usages", () => {
    expect(usageName(0x01, 0x7ffe)).toBe("Usage 0x7FFE");
  });
});

/* ------------------------------------------------------------------ *
 * descriptor parsing
 * ------------------------------------------------------------------ */

describe("parseReportDescriptor: boot mouse", () => {
  const parsed = parseReportDescriptor(BOOT_MOUSE);

  it("reads every item with the right offsets and depths", () => {
    expect(parsed.byteLength).toBe(50);
    expect(parsed.items).toHaveLength(26);
    expect(parsed.items[0]).toMatchObject({
      offset: 0,
      type: "Global",
      tagName: "Usage Page",
      size: 1,
      value: 1,
      depth: 0,
      description: "Usage Page (Generic Desktop)",
    });
    expect(parsed.items[2]).toMatchObject({ description: "Collection (Application)", depth: 0 });
    expect(parsed.items[3]).toMatchObject({ description: "Usage (Pointer)", depth: 1 });
    expect(parsed.items[4]).toMatchObject({ description: "Collection (Physical)", depth: 1 });
    expect(parsed.items[24]).toMatchObject({ description: "End Collection", depth: 1 });
    expect(parsed.items[25]).toMatchObject({ description: "End Collection", depth: 0 });
  });

  it("decodes the main item bitfields into names", () => {
    const inputs = parsed.items.filter((i) => i.tagName === "Input").map((i) => i.description);
    expect(inputs).toEqual([
      "Input (Data, Variable, Absolute)",
      "Input (Constant, Variable, Absolute)",
      "Input (Data, Variable, Relative)",
    ]);
  });

  it("sign extends the logical minimum but not an unsigned maximum", () => {
    const mins = parsed.items.filter((i) => i.tagName === "Logical Minimum");
    expect(mins.map((i) => i.description)).toEqual([
      "Logical Minimum (0)",
      "Logical Minimum (-127)",
    ]);
    const maxes = parsed.items.filter((i) => i.tagName === "Logical Maximum");
    expect(maxes.map((i) => i.description)).toEqual([
      "Logical Maximum (1)",
      "Logical Maximum (127)",
    ]);
  });

  it("records the application collection", () => {
    expect(parsed.applications).toEqual([
      { usagePage: 0x01, usage: 0x02, name: "Generic Desktop / Mouse" },
    ]);
    expect(parsed.usesReportIds).toBe(false);
  });

  it("computes the report layout exactly", () => {
    expect(parsed.reports).toHaveLength(1);
    const layout = parsed.reports[0]!;
    expect(layout.kind).toBe("input");
    expect(layout.reportId).toBe(0);
    expect(layout.totalBits).toBe(24);
    expect(layout.totalBytes).toBe(3);
    expect(fieldSummary(layout)).toEqual([
      ["Button 1", 0, 1, 1],
      ["Button 2", 1, 1, 1],
      ["Button 3", 2, 1, 1],
      ["Padding", 3, 5, 1],
      ["X", 8, 8, 1],
      ["Y", 16, 8, 1],
    ]);
    expect(layout.fields[4]).toMatchObject({
      usagePage: 0x01,
      usage: 0x30,
      logicalMinimum: -127,
      logicalMaximum: 127,
      isRelative: true,
      isSigned: true,
    });
    expect(layout.fields[0]).toMatchObject({ isRelative: false, isSigned: false, isArray: false });
  });
});

describe("parseReportDescriptor: boot keyboard", () => {
  const parsed = parseReportDescriptor(BOOT_KEYBOARD);

  it("builds one input and one output layout", () => {
    expect(parsed.reports.map((r) => r.kind)).toEqual(["input", "output"]);
  });

  it("lays out the modifier bits, the reserved byte and the key array", () => {
    const layout = parsed.reports[0]!;
    expect(layout.totalBits).toBe(64);
    expect(layout.totalBytes).toBe(8);
    expect(fieldSummary(layout)).toEqual([
      ["Left Control", 0, 1, 1],
      ["Left Shift", 1, 1, 1],
      ["Left Alt", 2, 1, 1],
      ["Left GUI", 3, 1, 1],
      ["Right Control", 4, 1, 1],
      ["Right Shift", 5, 1, 1],
      ["Right Alt", 6, 1, 1],
      ["Right GUI", 7, 1, 1],
      ["Padding", 8, 8, 1],
      ["Keyboard/Keypad array", 16, 8, 6],
    ]);
    expect(layout.fields[9]).toMatchObject({
      isArray: true,
      usageMinimum: 0x00,
      usageMaximum: 0x65,
      logicalMinimum: 0,
      logicalMaximum: 101,
    });
  });

  it("lays out the LED output report from a usage range", () => {
    const layout = parsed.reports[1]!;
    expect(layout.totalBytes).toBe(1);
    expect(fieldSummary(layout)).toEqual([
      ["Num Lock", 0, 1, 1],
      ["Caps Lock", 1, 1, 1],
      ["Scroll Lock", 2, 1, 1],
      ["Compose", 3, 1, 1],
      ["Kana", 4, 1, 1],
      ["Padding", 5, 3, 1],
    ]);
  });
});

describe("parseReportDescriptor: gamepad with a report ID", () => {
  const parsed = parseReportDescriptor(GAMEPAD);

  it("renders the whole tree", () => {
    expect(formatDescriptorTree(parsed.items, false)).toBe(
      [
        "Usage Page (Generic Desktop)",
        "Usage (Game Pad)",
        "Collection (Application)",
        "  Report ID (3)",
        "  Usage (X)",
        "  Usage (Y)",
        "  Logical Minimum (-2048)",
        "  Logical Maximum (2047)",
        "  Report Size (12)",
        "  Report Count (2)",
        "  Input (Data, Variable, Absolute)",
        "  Usage Page (Button)",
        "  Usage Minimum (Button 1)",
        "  Usage Maximum (Button 8)",
        "  Logical Minimum (0)",
        "  Logical Maximum (1)",
        "  Report Size (1)",
        "  Report Count (8)",
        "  Input (Data, Variable, Absolute)",
        "End Collection",
      ].join("\n"),
    );
  });

  it("shows raw bytes beside the tree when asked", () => {
    const lines = formatDescriptorTree(parsed.items, true).split("\n");
    expect(lines[0]).toBe("05 01          Usage Page (Generic Desktop)");
    expect(lines[6]).toBe("16 00 F8         Logical Minimum (-2048)");
  });

  it("keys the layout by report ID and packs the 12 bit axes", () => {
    expect(parsed.usesReportIds).toBe(true);
    expect(parsed.reports).toHaveLength(1);
    const layout = parsed.reports[0]!;
    expect(layout.reportId).toBe(3);
    expect(layout.totalBits).toBe(32);
    expect(layout.totalBytes).toBe(4);
    expect(fieldSummary(layout).slice(0, 3)).toEqual([
      ["X", 0, 12, 1],
      ["Y", 12, 12, 1],
      ["Button 1", 24, 1, 1],
    ]);
    expect(layout.fields[0]).toMatchObject({
      logicalMinimum: -2048,
      logicalMaximum: 2047,
      isSigned: true,
    });
  });
});

describe("parseReportDescriptor: errors and edges", () => {
  it("throws with the offset when a short item is truncated", () => {
    try {
      parseReportDescriptor(Uint8Array.from([0x05, 0x01, 0x09]));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      const e = err as ToolError;
      expect(e.code).toBe("truncated-descriptor");
      expect(e.message).toContain("offset 2");
      expect(e.message).toContain("1 data bytes but only 0 remain");
      expect(e.fix).toBeTruthy();
    }
  });

  it("throws when a multi byte item runs off the end", () => {
    expect(() => parseReportDescriptor(Uint8Array.from([0x16, 0x00]))).toThrowError(
      /offset 0 declares 2 data bytes but only 1 remain/,
    );
  });

  it("accepts an empty descriptor without throwing", () => {
    const parsed = parseReportDescriptor(new Uint8Array());
    expect(parsed.items).toEqual([]);
    expect(parsed.reports).toEqual([]);
    expect(formatDescriptorTree(parsed.items)).toBe("The descriptor contains no items.");
    expect(formatReportLayouts(parsed.reports)).toBe(
      "No input, output or feature reports were declared.",
    );
  });

  it("clamps a stray End Collection instead of going negative", () => {
    const parsed = parseReportDescriptor(Uint8Array.from([0xc0, 0x05, 0x01]));
    expect(parsed.items[0]).toMatchObject({ description: "End Collection", depth: 0 });
    expect(parsed.items[1]).toMatchObject({ depth: 0 });
  });

  it("restores global state across Push and Pop", () => {
    const parsed = parseReportDescriptor(
      Uint8Array.from([
        0x75,
        0x08, // Report Size (8)
        0xa4, //       Push
        0x75,
        0x10, // Report Size (16)
        0xb4, //       Pop
        0x95,
        0x01, // Report Count (1)
        0x81,
        0x02, // Input (Data, Variable, Absolute)
      ]),
    );
    expect(parsed.items[1]!.description).toBe("Push");
    expect(parsed.items[3]!.description).toBe("Pop");
    expect(parsed.reports[0]!.totalBits).toBe(8);
  });
});

/* ------------------------------------------------------------------ *
 * decoding
 * ------------------------------------------------------------------ */

describe("extractBits", () => {
  it("reads LSB first inside a byte", () => {
    const data = Uint8Array.from([0b1010_0101]);
    expect(extractBits(data, 0, 1)).toBe(1);
    expect(extractBits(data, 1, 1)).toBe(0);
    expect(extractBits(data, 0, 4)).toBe(0b0101);
    expect(extractBits(data, 4, 4)).toBe(0b1010);
  });

  it("reads past the end of the buffer as zero", () => {
    expect(extractBits(Uint8Array.from([0xff]), 8, 8)).toBe(0);
  });
});

describe("decodeInputReport", () => {
  it("decodes a boot mouse report", () => {
    const layout = inputLayout(BOOT_MOUSE);
    const fields = decodeInputReport(layout, Uint8Array.from([0x05, 0xfe, 0x02]));
    expect(fields.map((f) => [f.name, f.value])).toEqual([
      ["Button 1", 1],
      ["Button 2", 0],
      ["Button 3", 1],
      ["Padding", 0],
      ["X", -2],
      ["Y", 2],
    ]);
    expect(fields[0]!.display).toBe("1 (on)");
    expect(fields[4]!.display).toBe("-2");
  });

  it("decodes 12 bit fields that cross byte boundaries, with sign", () => {
    const layout = inputLayout(GAMEPAD, 3);
    const fields = decodeInputReport(layout, Uint8Array.from([0xff, 0x07, 0xf8, 0x81]));
    expect(fields[0]).toMatchObject({ name: "X", value: 2047 });
    expect(fields[1]).toMatchObject({ name: "Y", value: -128 });
    expect(fields.slice(2).map((f) => f.value)).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
    expect(fields[9]!.name).toBe("Button 8");
  });

  it("decodes an unsigned 12 bit field when the logical minimum is zero", () => {
    const layout = inputLayout(GAMEPAD, 3);
    const unsigned: ReportLayout = {
      ...layout,
      fields: layout.fields.map((f) =>
        f.name === "X" ? { ...f, isSigned: false, logicalMinimum: 0, logicalMaximum: 4095 } : f,
      ),
    };
    const fields = decodeInputReport(unsigned, Uint8Array.from([0x34, 0x12, 0x00, 0x00]));
    expect(fields[0]!.value).toBe(0x234);
  });

  it("decodes the keyboard modifier bits and the key array", () => {
    const layout = inputLayout(BOOT_KEYBOARD);
    const fields = decodeInputReport(
      layout,
      Uint8Array.from([0x22, 0x00, 0x04, 0x05, 0x00, 0x00, 0x00, 0x00]),
    );
    expect(fields[1]).toMatchObject({ name: "Left Shift", value: 1 });
    expect(fields[5]).toMatchObject({ name: "Right Shift", value: 1 });
    expect(fields[0]!.value).toBe(0);
    const keys = fields[9]!;
    expect(keys.isArray).toBe(true);
    expect(keys.values).toEqual([0x04, 0x05]);
    expect(keys.names).toEqual(["A", "B"]);
    expect(keys.display).toBe("A, B");
  });

  it("shows an empty key array as (none)", () => {
    const layout = inputLayout(BOOT_KEYBOARD);
    const fields = decodeInputReport(layout, new Uint8Array(8));
    expect(fields[9]!.display).toBe("(none)");
  });

  it("treats missing trailing bytes as zero", () => {
    const layout = inputLayout(BOOT_MOUSE);
    const fields = decodeInputReport(layout, Uint8Array.from([0x01]));
    expect(fields.map((f) => f.value)).toEqual([1, 0, 0, 0, 0, 0]);
  });
});

/* ------------------------------------------------------------------ *
 * formatting
 * ------------------------------------------------------------------ */

describe("formatReportHex", () => {
  it("aligns the hex bytes over an LSB first bit ruler", () => {
    expect(formatReportHex(Uint8Array.from([0x05, 0xfe]))).toBe(
      ["0000  05       FE", "      10100000 01111111"].join("\n"),
    );
  });

  it("groups long reports eight bytes at a time", () => {
    const lines = formatReportHex(new Uint8Array(10)).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]!.startsWith("0000  ")).toBe(true);
    expect(lines[2]!.startsWith("0008  ")).toBe(true);
  });

  it("labels an empty report", () => {
    expect(formatReportHex(new Uint8Array())).toBe("(empty report)");
  });
});

describe("formatReportLayouts", () => {
  it("writes a header and one aligned line per field", () => {
    const text = formatReportLayouts(parseReportDescriptor(GAMEPAD).reports);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Input report, ID 3, 4 bytes (32 bits)");
    expect(lines[1]).toBe(
      "  bit 0     12 bits     X                         logical -2048..2047  [signed]",
    );
    expect(lines[3]).toBe("  bit 24    1 bits      Button 1                  logical 0..1");
  });

  it("says when a report has no report ID", () => {
    const text = formatReportLayouts(parseReportDescriptor(BOOT_MOUSE).reports);
    expect(text.split("\n")[0]).toBe("Input report, no report ID, 3 bytes (24 bits)");
  });
});

/* ------------------------------------------------------------------ *
 * WebHID collections
 * ------------------------------------------------------------------ */

const MOUSE_COLLECTIONS: HidCollectionInfo[] = [
  {
    usagePage: 0x01,
    usage: 0x02,
    type: 0x01,
    children: [],
    inputReports: [
      {
        reportId: 0,
        items: [
          {
            isAbsolute: true,
            isArray: false,
            isConstant: false,
            isRange: true,
            usageMinimum: 0x0009_0001,
            usageMaximum: 0x0009_0003,
            reportSize: 1,
            reportCount: 3,
            logicalMinimum: 0,
            logicalMaximum: 1,
          },
          {
            isAbsolute: true,
            isArray: false,
            isConstant: true,
            isRange: false,
            reportSize: 5,
            reportCount: 1,
            logicalMinimum: 0,
            logicalMaximum: 0,
          },
          {
            isAbsolute: false,
            isArray: false,
            isConstant: false,
            isRange: false,
            usages: [0x0001_0030, 0x0001_0031],
            reportSize: 8,
            reportCount: 2,
            logicalMinimum: -127,
            logicalMaximum: 127,
          },
        ],
      },
    ],
    outputReports: [],
    featureReports: [],
  },
];

describe("layoutsFromCollections", () => {
  it("produces the same field layout the raw descriptor does", () => {
    const fromCollections = layoutsFromCollections(MOUSE_COLLECTIONS);
    expect(fromCollections).toHaveLength(1);
    expect(fieldSummary(fromCollections[0]!)).toEqual(fieldSummary(inputLayout(BOOT_MOUSE)));
    expect(fromCollections[0]!.totalBytes).toBe(3);
    expect(fromCollections[0]!.fields[4]).toMatchObject({
      name: "X",
      isRelative: true,
      isSigned: true,
      logicalMinimum: -127,
    });
  });

  it("decodes a live style report against a collection built layout", () => {
    const layout = layoutsFromCollections(MOUSE_COLLECTIONS)[0]!;
    const fields = decodeInputReport(layout, Uint8Array.from([0x04, 0x10, 0xf0]));
    expect(fields.map((f) => [f.name, f.value])).toEqual([
      ["Button 1", 0],
      ["Button 2", 0],
      ["Button 3", 1],
      ["Padding", 0],
      ["X", 16],
      ["Y", -16],
    ]);
  });

  it("renders the collection tree the browser exposes", () => {
    const tree = describeCollectionTree(MOUSE_COLLECTIONS);
    const lines = tree.split("\n");
    expect(lines[0]).toBe("Application collection: Generic Desktop / Mouse");
    expect(lines[1]).toBe("  Input report, no report ID, 3 bytes");
    expect(lines[2]).toContain("Button 1");
    expect(tree).toContain("X");
  });

  it("says so when a device reports no collections", () => {
    expect(describeCollectionTree([])).toBe("The device reported no collections.");
  });
});

/* ------------------------------------------------------------------ *
 * hex input
 * ------------------------------------------------------------------ */

describe("parseHexBytes", () => {
  it("reads plain spaced hex", () => {
    expect(Array.from(parseHexBytes("05 01 09 02"))).toEqual([5, 1, 9, 2]);
  });

  it("reads a C array with 0x prefixes, commas and comments", () => {
    const src = `static const uint8_t desc[] = {
      0x05, 0x01, // Usage Page (Generic Desktop)
      0x09, 0x02, /* Usage (Mouse) */
    };`;
    expect(Array.from(parseHexBytes(src))).toEqual([5, 1, 9, 2]);
  });

  it("reads one unbroken hex string", () => {
    expect(Array.from(parseHexBytes("05010902a101"))).toEqual([5, 1, 9, 2, 0xa1, 1]);
  });

  it("drops hexdump style offset columns", () => {
    expect(Array.from(parseHexBytes("0000: 05 01 09 02\n0004: a1 01"))).toEqual([
      5, 1, 9, 2, 0xa1, 1,
    ]);
  });

  it("reads backslash-x escapes", () => {
    expect(Array.from(parseHexBytes("\\x05\\x01\\xA1"))).toEqual([5, 1, 0xa1]);
  });

  it("rejects a token that is not hex", () => {
    try {
      parseHexBytes("05 zz 01");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid-hex");
      expect((err as ToolError).message).toContain('"zz"');
    }
  });

  it("rejects an odd length run of hex digits", () => {
    expect(() => parseHexBytes("05010")).toThrowError(/odd number of hex digits/);
  });

  it("rejects input with no hex bytes at all", () => {
    try {
      parseHexBytes("// nothing here");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("no-bytes");
    }
  });
});

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

describe("run", () => {
  it("explains the panel when there is no input", () => {
    const out = run("", {});
    expect(Object.keys(out)).toContain("Live capture");
    expect(out["Browser support"]).toContain("WebHID");
    expect(out["Privacy"]).toContain("your files and inputs never leave your device");
  });

  it("treats whitespace only input as no input", () => {
    expect(run("   \n\t ", {})).toEqual(run("", {}));
  });

  it("parses a pasted descriptor dump into a tree and a layout", () => {
    const dump = Array.from(BOOT_MOUSE, (b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ");
    const out = run(dump, {});
    expect(out["Summary"]).toContain("50 bytes, 26 items, 1 report layouts");
    expect(out["Summary"]).toContain("Generic Desktop / Mouse");
    expect(out["Descriptor tree"]).toContain("Usage Page (Generic Desktop)");
    expect(out["Report layout"]).toContain("Input report, no report ID, 3 bytes (24 bits)");
  });

  it("honours the view and showBytes options", () => {
    const dump = Array.from(GAMEPAD, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const treeOnly = run(dump, { view: "tree", showBytes: false });
    expect(Object.keys(treeOnly)).toEqual(["Summary", "Descriptor tree"]);
    expect(treeOnly["Descriptor tree"]!.split("\n")[0]).toBe("Usage Page (Generic Desktop)");

    const layoutOnly = run(dump, { view: "layout" });
    expect(Object.keys(layoutOnly)).toEqual(["Summary", "Report layout"]);
  });

  it("accepts raw bytes as well as a hex string", () => {
    expect(run(GAMEPAD, {})["Summary"]).toContain("Report IDs: yes");
  });

  it("throws on an empty byte array", () => {
    try {
      run(new Uint8Array(), {});
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("no-bytes");
    }
  });

  it("surfaces a truncated descriptor as a ToolError", () => {
    try {
      run("05 01 09", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("truncated-descriptor");
    }
  });
});
