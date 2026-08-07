import { describe, expect, it } from "vitest";
import {
  decodeFloat,
  decodeSFloat,
  downsampleForChart,
  formatValue,
  hexFallback,
  parseCharacteristic,
  parseHexBytes,
  ringBufferPush,
  run,
  toCsv,
  to16Bit,
  uuidName,
} from "./index";

/** Build a DataView over exactly the given bytes (offset zero, tight window). */
function view(...bytes: number[]): DataView {
  const array = Uint8Array.from(bytes);
  return new DataView(array.buffer, array.byteOffset, array.byteLength);
}

/** Collect a parsed characteristic's fields into a name -> field map. */
function fieldsByName(uuid: string, ...bytes: number[]) {
  const parsed = parseCharacteristic(uuid, view(...bytes));
  const map = new Map(parsed.fields.map((f) => [f.name, f]));
  return { parsed, map };
}

describe("IEEE-11073 SFLOAT (medfloat16)", () => {
  it("decodes a known vector with a negative exponent", () => {
    // mantissa 172, exponent -1 -> 172 * 10^-1 = 17.2
    expect(decodeSFloat(0xf0ac)).toBeCloseTo(17.2, 10);
  });

  it("decodes zero and a positive integer", () => {
    expect(decodeSFloat(0x0000)).toBe(0);
    expect(decodeSFloat(0x0001)).toBe(1);
  });

  it("decodes a negative mantissa", () => {
    expect(decodeSFloat(0x0fff)).toBe(-1);
  });

  it("returns NaN and the infinities for the reserved codes", () => {
    expect(Number.isNaN(decodeSFloat(0x07ff))).toBe(true); // NaN
    expect(Number.isNaN(decodeSFloat(0x0800))).toBe(true); // NRes
    expect(decodeSFloat(0x07fe)).toBe(Infinity);
    expect(decodeSFloat(0x0802)).toBe(-Infinity);
  });
});

describe("IEEE-11073 FLOAT (medfloat32)", () => {
  it("decodes a known vector: 3700 * 10^-2 = 37.0", () => {
    // raw 0xFE000E74: exponent 0xFE = -2, mantissa 0x000E74 = 3700
    expect(decodeFloat(0xfe000e74)).toBeCloseTo(37.0, 10);
  });

  it("returns NaN for the reserved NaN code", () => {
    expect(Number.isNaN(decodeFloat(0x007fffff))).toBe(true);
  });

  it("decodes the infinities", () => {
    expect(decodeFloat(0x007ffffe)).toBe(Infinity);
    expect(decodeFloat(0x00800002)).toBe(-Infinity);
  });
});

describe("Heart Rate Measurement (0x2A37)", () => {
  it("reads the 8-bit value form with an RR interval", () => {
    // flags 0x10 (RR present, uint8), bpm 72, RR 0x0400 = 1024 -> 1000 ms
    const { map } = fieldsByName("2a37", 0x10, 0x48, 0x00, 0x04);
    expect(map.get("Heart rate")?.value).toBe(72);
    expect(map.get("Heart rate")?.unit).toBe("bpm");
    expect(map.get("RR interval 1")?.value).toBe(1000);
    expect(map.get("RR interval 1")?.unit).toBe("ms");
  });

  it("reads the 16-bit value form with energy and RR intervals", () => {
    // flags 0x19 (uint16, energy, RR), bpm 200, energy 1000 kJ, RR 1024 -> 1000 ms
    const { map } = fieldsByName("2a37", 0x19, 0xc8, 0x00, 0xe8, 0x03, 0x00, 0x04);
    expect(map.get("Heart rate")?.value).toBe(200);
    expect(map.get("Energy expended")?.value).toBe(1000);
    expect(map.get("RR interval 1")?.value).toBe(1000);
  });

  it("reports sensor contact when the flag says it is supported", () => {
    // flags 0x06 (contact supported + detected), bpm 60
    const { map } = fieldsByName("2a37", 0x06, 0x3c);
    expect(map.get("Sensor contact")?.value).toBe("yes");
    expect(map.get("Heart rate")?.value).toBe(60);
  });
});

describe("CSC Measurement (0x2A5B)", () => {
  it("decodes the wheel and crank blocks", () => {
    // flags 0x03, wheel revs 100, wheel event 1024 -> 1000 ms,
    // crank revs 50, crank event 1024 -> 1000 ms
    const { map } = fieldsByName(
      "2a5b",
      0x03,
      0x64,
      0x00,
      0x00,
      0x00,
      0x00,
      0x04,
      0x32,
      0x00,
      0x00,
      0x04,
    );
    expect(map.get("Wheel revolutions")?.value).toBe(100);
    expect(map.get("Last wheel event")?.value).toBe(1000);
    expect(map.get("Crank revolutions")?.value).toBe(50);
    expect(map.get("Last crank event")?.value).toBe(1000);
  });
});

describe("Environmental Sensing characteristics", () => {
  it("decodes a negative temperature (0x2A6E)", () => {
    // sint16 LE 0xFBE6 = -1050 -> -10.5 C
    const { map } = fieldsByName("2a6e", 0xe6, 0xfb);
    expect(map.get("Temperature")?.value).toBeCloseTo(-10.5, 10);
    expect(map.get("Temperature")?.unit).toBe("°C");
  });

  it("decodes humidity (0x2A6F)", () => {
    // uint16 LE 5025 -> 50.25 %
    const { map } = fieldsByName("2a6f", 0xa1, 0x13);
    expect(map.get("Humidity")?.value).toBeCloseTo(50.25, 10);
  });

  it("decodes pressure as uint32 (0x2A6D)", () => {
    // uint32 LE 1013250 (0x000F7602) -> 101325.0 Pa (one standard atmosphere)
    const { map } = fieldsByName("2a6d", 0x02, 0x76, 0x0f, 0x00);
    expect(map.get("Pressure")?.value).toBeCloseTo(101325.0, 5);
    expect(map.get("Pressure")?.unit).toBe("Pa");
  });
});

describe("Battery Level (0x2A19)", () => {
  it("decodes the percentage", () => {
    const { map } = fieldsByName("2a19", 0x5a);
    expect(map.get("Battery level")?.value).toBe(90);
    expect(map.get("Battery level")?.unit).toBe("%");
  });
});

describe("Temperature Measurement (0x2A1C)", () => {
  it("decodes the 32-bit FLOAT body of a Celsius reading", () => {
    // flags 0x00 (Celsius, no extras), FLOAT 0xFE000E74 -> 37.0
    const { map } = fieldsByName("2a1c", 0x00, 0x74, 0x0e, 0x00, 0xfe);
    expect(map.get("Temperature")?.value).toBeCloseTo(37.0, 10);
    expect(map.get("Temperature")?.unit).toBe("°C");
  });
});

describe("UUID naming", () => {
  it("names the short form", () => {
    expect(uuidName("0x2A19")).toBe("Battery Level");
    expect(uuidName("2a37")).toBe("Heart Rate Measurement");
  });

  it("names the full 128-bit form", () => {
    expect(uuidName("00002a19-0000-1000-8000-00805f9b34fb")).toBe("Battery Level");
    expect(uuidName("0000180d-0000-1000-8000-00805f9b34fb")).toBe("Heart Rate");
  });

  it("reduces base-range UUIDs to their short code", () => {
    expect(to16Bit("00002a6e-0000-1000-8000-00805f9b34fb")).toBe("2a6e");
    expect(to16Bit("0x2A6E")).toBe("2a6e");
  });

  it("keeps a vendor 128-bit UUID whole", () => {
    const custom = "12345678-1234-5678-9abc-def012345678";
    expect(to16Bit(custom)).toBeNull();
    expect(uuidName(custom)).toBe(custom);
  });
});

describe("hex fallback for unknown characteristics", () => {
  it("renders unknown UUIDs as hex", () => {
    const { map } = fieldsByName("12345678-1234-5678-9abc-def012345678", 0xde, 0xad, 0xbe, 0xef);
    expect(map.get("Raw bytes")?.value).toBe("de ad be ef");
  });

  it("falls back to hex when a known parser gets too few bytes", () => {
    // Battery Level needs one byte; give it none.
    const parsed = parseCharacteristic("2a19", view());
    expect(parsed.fields[0]?.name).toBe("Raw bytes");
    expect(parsed.fields[0]?.value).toBe("(empty)");
  });

  it("reads through a DataView window, not the whole backing buffer", () => {
    const backing = Uint8Array.from([0xff, 0xff, 0x01, 0x02, 0xff]);
    const windowed = new DataView(backing.buffer, 2, 2);
    expect(hexFallback(windowed).fields[0]?.value).toBe("01 02");
  });
});

describe("downsampleForChart", () => {
  it("keeps the endpoints and the exact count", () => {
    const series = Array.from({ length: 1000 }, (_, i) => ({ t: i, value: i }));
    const out = downsampleForChart(series, 100);
    expect(out).toHaveLength(100);
    expect(out[0]).toBe(series[0]);
    expect(out[out.length - 1]).toBe(series[series.length - 1]);
  });

  it("returns a copy unchanged when it already fits", () => {
    const series = [
      { t: 0, value: 1 },
      { t: 1, value: 2 },
    ];
    const out = downsampleForChart(series, 100);
    expect(out).toEqual(series);
    expect(out).not.toBe(series);
  });
});

describe("ringBufferPush", () => {
  it("keeps only the most recent entries in order", () => {
    const buffer: number[] = [];
    for (let i = 1; i <= 5; i++) ringBufferPush(buffer, i, 3);
    expect(buffer).toEqual([3, 4, 5]);
  });
});

describe("toCsv", () => {
  it("formats a timestamped CSV and escapes commas", () => {
    const csv = toCsv([
      { t: 0, name: "Heart rate", value: 72 },
      { t: 1000, name: "Heart rate, resting", value: 60 },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("timestamp,field,value");
    expect(lines[1]).toBe("1970-01-01T00:00:00.000Z,Heart rate,72");
    // The comma in the field name forces quoting.
    expect(lines[2]).toBe('1970-01-01T00:00:01.000Z,"Heart rate, resting",60');
  });

  it("renders non-finite numbers as text", () => {
    expect(formatValue(NaN)).toBe("NaN");
    expect(formatValue(Infinity)).toBe("Infinity");
  });
});

describe("parseHexBytes", () => {
  it("accepts spaces, commas and 0x prefixes", () => {
    expect(Array.from(parseHexBytes("0x01, 0x3C 04"))).toEqual([1, 60, 4]);
  });

  it("rejects an odd number of nibbles", () => {
    expect(() => parseHexBytes("013")).toThrowError(/odd number/);
  });

  it("rejects non-hex characters", () => {
    expect(() => parseHexBytes("zz")).toThrowError(/not a hex/);
  });
});

describe("run", () => {
  it("returns usage rows with no input", () => {
    const out = run("");
    expect(out.Privacy).toContain("your files and inputs never leave your device");
    expect(out["How this works"]).toBeTruthy();
  });

  it("decodes a hex payload for a given characteristic UUID", () => {
    const out = run("10 48 00 04", { uuid: "2a37" });
    expect(out.Characteristic).toBe("Heart Rate Measurement");
    expect(out["Heart rate"]).toBe("72 bpm");
    expect(out["RR interval 1"]).toBe("1000 ms");
  });

  it("falls back to raw hex when no UUID is given", () => {
    const out = run("de ad", {});
    expect(out.Characteristic).toBe("Unknown (raw hex)");
    expect(out["Raw bytes"]).toBe("de ad");
  });

  it("decodes with a full 128-bit UUID, the live panel path", () => {
    // char.uuid always arrives in full form, so exercise that end to end.
    const out = run("10 48 00 04", { uuid: "00002a37-0000-1000-8000-00805f9b34fb" });
    expect(out.Characteristic).toBe("Heart Rate Measurement");
    expect(out["Heart rate"]).toBe("72 bpm");
  });
});
