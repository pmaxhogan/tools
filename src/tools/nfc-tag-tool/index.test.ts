import { describe, expect, it } from "vitest";
import {
  buildRecord,
  decodeMessage,
  describeRecords,
  encodeMessage,
  run,
  tagCapacityFit,
  toWebNfcMessage,
  type DecodedRecord,
} from "./index";

describe("buildRecord: exact NDEF byte vectors", () => {
  it("encodes a text record for hello/en to the documented bytes", () => {
    const built = buildRecord("text", "hello");
    expect(Array.from(built.bytes)).toEqual([
      0xd1, 0x01, 0x08, 0x54, 0x02, 0x65, 0x6e, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
    ]);
  });

  it("encodes a URL record for https://example.com to the documented bytes", () => {
    const built = buildRecord("url", "https://example.com");
    expect(Array.from(built.bytes)).toEqual([
      0xd1, 0x01, 0x0c, 0x55, 0x04, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x63, 0x6f, 0x6d,
    ]);
  });

  it("abbreviates http://www. and https://www. distinctly from the bare schemes", () => {
    const plain = buildRecord("url", "http://example.com");
    expect(plain.bytes[4]).toBe(0x03); // "http://"
    const www = buildRecord("url", "https://www.example.com");
    expect(www.bytes[4]).toBe(0x02); // "https://www." (longest match wins over "https://")
  });

  it("falls back to no abbreviation for a scheme not in the table", () => {
    const built = buildRecord("geo", "37.7749,-122.4194");
    expect(built.bytes[4]).toBe(0x00);
  });
});

describe("run: build mode output shape", () => {
  it("returns the expected labeled rows for a text record", () => {
    const out = run("hello", { kind: "text" });
    expect(out["Record type"]).toBe("Text");
    expect(out["Payload preview"]).toBe("hello [en, utf-8]");
    expect(out["NDEF bytes (hex)"]).toBe("D1 01 08 54 02 65 6E 68 65 6C 6C 6F");
    expect(out["Fits on"]).toBe("NTAG213, NTAG215, NTAG216, Mifare Ultralight, Topaz 512");
  });

  it("defaults to the text kind when no kind is given", () => {
    const out = run("hi there");
    expect(out["Record type"]).toBe("Text");
  });

  it("returns the exact URL bytes through the run() surface", () => {
    const out = run("https://example.com", { kind: "url" });
    expect(out["NDEF bytes (hex)"]).toBe("D1 01 0C 55 04 65 78 61 6D 70 6C 65 2E 63 6F 6D");
    expect(out["Payload preview"]).toBe("https://example.com");
  });

  it("resolves kind synonyms", () => {
    expect(run("https://a.io", { kind: "website" })["Record type"]).toBe("URL");
    expect(run("Jane;;;", { kind: "contact" })["Record type"]).toBe("vCard contact");
    expect(run("+15551234567", { kind: "phone" })["Record type"]).toBe("Phone number");
  });
});

describe("decode round trips", () => {
  function roundTrip(kind: string, value: string): DecodedRecord {
    const built = buildRecord(kind, value);
    const decoded = decodeMessage(built.bytes);
    expect(decoded).toHaveLength(1);
    return decoded[0] as DecodedRecord;
  }

  it("round trips text with language and UTF-8 encoding", () => {
    const record = roundTrip("text", "hello");
    expect(record).toEqual({ kind: "text", lang: "en", encoding: "utf-8", text: "hello" });
  });

  it("round trips a URL", () => {
    const record = roundTrip("url", "https://example.com/path?q=1");
    expect(record).toEqual({ kind: "url", url: "https://example.com/path?q=1" });
  });

  it("round trips a Wi-Fi credential through the WSC TLVs", () => {
    const record = roundTrip("wifi", "MyNetwork;secret123;WPA2");
    expect(record).toEqual({ kind: "wifi", ssid: "MyNetwork", key: "secret123", auth: "WPA2" });
  });

  it("round trips a Wi-Fi credential with a non-default auth type", () => {
    const record = roundTrip("wifi", "OldRouter;wepkey12345;WEP");
    expect(record).toEqual({ kind: "wifi", ssid: "OldRouter", key: "wepkey12345", auth: "WEP" });
  });

  it("round trips a vCard's N/FN, TEL, EMAIL and URL fields", () => {
    const record = roundTrip("vcard", "Jane Doe;+15551234567;jane@example.com;https://example.com/jane");
    expect(record.kind).toBe("vcard");
    if (record.kind === "vcard") {
      expect(record.name).toBe("Jane Doe");
      expect(record.tel).toBe("+15551234567");
      expect(record.email).toBe("jane@example.com");
      expect(record.url).toBe("https://example.com/jane");
      expect(record.raw).toContain("BEGIN:VCARD");
    }
  });

  it("round trips a geo URI into lat/lon numbers", () => {
    const record = roundTrip("geo", "37.7749,-122.4194");
    expect(record).toEqual({ kind: "geo", lat: 37.7749, lon: -122.4194 });
  });

  it("round trips tel, mailto and sms records", () => {
    expect(roundTrip("tel", "+15551234567")).toEqual({ kind: "tel", number: "+15551234567" });
    expect(roundTrip("mailto", "jane@example.com")).toEqual({
      kind: "mailto",
      address: "jane@example.com",
    });
    expect(roundTrip("sms", "+15551234567;Hello there")).toEqual({
      kind: "sms",
      number: "+15551234567",
      body: "Hello there",
    });
    expect(roundTrip("sms", "+15551234567")).toEqual({ kind: "sms", number: "+15551234567" });
  });

  it("round trips an Android Application Record", () => {
    expect(roundTrip("app", "com.example.app")).toEqual({
      kind: "app",
      packageName: "com.example.app",
    });
  });

  it("round trips an empty record regardless of the input value", () => {
    expect(roundTrip("empty", "ignored")).toEqual({ kind: "empty" });
    const built = buildRecord("empty", "");
    expect(Array.from(built.bytes)).toEqual([0xd0, 0x00, 0x00]);
  });

  it("decodes an unrecognized well-known type as unknown rather than failing", () => {
    const bytes = encodeMessage([{ tnf: 0x01, type: "X", payload: Uint8Array.of(1, 2, 3) }]);
    const decoded = decodeMessage(bytes);
    expect(decoded[0]).toEqual({ kind: "unknown", tnf: 1, type: "X", bytes: Uint8Array.of(1, 2, 3) });
  });
});

describe("describeRecords", () => {
  it("labels each record with its 1-based index and kind", () => {
    const built1 = buildRecord("text", "hello");
    const built2 = buildRecord("url", "https://example.com");
    const decoded = decodeMessage(encodeMessage([built1.record, built2.record]));
    const described = describeRecords(decoded);
    expect(described["Record 1 (Text)"]).toBe("hello [en, utf-8]");
    expect(described["Record 2 (URL)"]).toBe("https://example.com");
  });
});

describe("encodeMessage: MB/ME flags across a multi-record message", () => {
  it("sets MB only on the first record's header and ME only on the last", () => {
    const built1 = buildRecord("text", "hi");
    const built2 = buildRecord("url", "https://a.io");
    const message = encodeMessage([built1.record, built2.record]);

    const header1 = message[0] as number;
    expect(header1 & 0x80).toBeTruthy(); // MB set on the first record
    expect(header1 & 0x40).toBe(0); // ME not set on the first record

    // The second record's header sits right after record 1's standalone bytes:
    // MB/ME flags don't change a record's encoded length, only the header bits.
    const header2 = message[built1.bytes.length] as number;
    expect(header2 & 0x80).toBe(0); // MB not set on a later record
    expect(header2 & 0x40).toBeTruthy(); // ME set on the last record

    const decoded = decodeMessage(message);
    expect(decoded).toHaveLength(2);
  });
});

describe("tagCapacityFit", () => {
  it("reports a fit verdict against a known tag's capacity", () => {
    const fit = tagCapacityFit(100, "NTAG213");
    expect(fit).toEqual({
      tagType: "NTAG213",
      capacityBytes: 144,
      fits: true,
      verdict: "Fits on NTAG213 (144 B usable, message is 100 B).",
    });
  });

  it("reports a does-not-fit verdict when the message is too big", () => {
    const fit = tagCapacityFit(500, "NTAG213");
    expect(fit.fits).toBe(false);
    expect(fit.verdict).toContain("Does not fit");
  });

  it("handles the smallest common tag, Mifare Ultralight (48 B)", () => {
    expect(tagCapacityFit(40, "Mifare Ultralight").fits).toBe(true);
    expect(tagCapacityFit(50, "Mifare Ultralight").fits).toBe(false);
  });

  it("returns a not-fitting verdict for an unrecognized tag type", () => {
    const fit = tagCapacityFit(10, "Some Unknown Tag");
    expect(fit.fits).toBe(false);
    expect(fit.capacityBytes).toBe(0);
  });
});

describe("toWebNfcMessage", () => {
  it("shapes a text and URL message for NDEFReader.write()", () => {
    const built1 = buildRecord("text", "hello");
    const built2 = buildRecord("url", "https://example.com");
    const message = toWebNfcMessage([built1.record, built2.record]);
    expect(message.records[0]).toEqual({
      recordType: "text",
      data: "hello",
      lang: "en",
      encoding: "utf-8",
    });
    expect(message.records[1]).toEqual({ recordType: "url", data: "https://example.com" });
  });

  it("shapes a Wi-Fi record as a MIME record and an app record as its external type", () => {
    const wifi = buildRecord("wifi", "MyNet;secret123;WPA2");
    expect(toWebNfcMessage([wifi.record]).records[0]?.recordType).toBe("mime");
    expect(toWebNfcMessage([wifi.record]).records[0]?.mediaType).toBe("application/vnd.wfa.wsc");

    const app = buildRecord("app", "com.example.app");
    expect(toWebNfcMessage([app.record]).records[0]).toEqual({
      recordType: "android.com:pkg",
      data: new TextEncoder().encode("com.example.app"),
    });
  });

  it("shapes an empty record", () => {
    const empty = buildRecord("empty", "");
    expect(toWebNfcMessage([empty.record]).records[0]).toEqual({ recordType: "empty" });
  });
});

describe("ToolError: empty-input", () => {
  it("rejects an empty value for a build kind", () => {
    expect(() => run("", { kind: "text" })).toThrowError(/enter a value/i);
  });

  it("rejects a whitespace-only value", () => {
    expect(() => run("   ", { kind: "url" })).toThrowError(/enter a value/i);
  });

  it("rejects empty input for raw-hex-decode", () => {
    expect(() => run("", { kind: "raw-hex-decode" })).toThrowError(/paste the hex bytes/i);
  });

  it("builds the empty record even with a blank value", () => {
    expect(() => run("", { kind: "empty" })).not.toThrow();
  });
});

describe("ToolError: bad-url", () => {
  it("rejects an unparseable URL", () => {
    expect(() => run("not a url", { kind: "url" })).toThrowError(/not a valid URL/i);
  });

  it("accepts a bare domain by assuming https", () => {
    const out = run("example.com", { kind: "url" });
    expect(out["Payload preview"]).toBe("https://example.com");
  });

  it("rejects a malformed geo pair", () => {
    expect(() => run("nowhere", { kind: "geo" })).toThrowError(/lat,lon/i);
  });

  it("rejects a phone number with no digits", () => {
    expect(() => run("call-me-maybe", { kind: "tel" })).toThrowError(/phone number/i);
  });

  it("rejects a malformed email address", () => {
    expect(() => run("not-an-email", { kind: "mailto" })).toThrowError(/valid email/i);
  });

  it("rejects an sms value with no digits", () => {
    expect(() => run("no-numbers-here", { kind: "sms" })).toThrowError(/phone number/i);
  });
});

describe("ToolError: bad-wifi", () => {
  it("rejects a Wi-Fi value missing the password", () => {
    expect(() => run("MyNetwork", { kind: "wifi" })).toThrowError(/network name and a password/i);
  });

  it("rejects an unrecognized auth type", () => {
    expect(() => run("MyNetwork;secret123;BOGUS", { kind: "wifi" })).toThrowError(
      /not a recognized Wi-Fi security type/i,
    );
  });
});

describe("ToolError: bad-hex", () => {
  it("rejects non-hex characters", () => {
    expect(() => run("zz", { kind: "raw-hex-decode" })).toThrowError(/not a hex/i);
  });

  it("rejects an odd number of nibbles", () => {
    expect(() => run("d10", { kind: "raw-hex-decode" })).toThrowError(/odd number/i);
  });
});

describe("ToolError: bad-ndef", () => {
  it("rejects a header missing the message begin flag", () => {
    expect(() => run("00", { kind: "raw-hex-decode" })).toThrowError(/message begin/i);
  });

  it("rejects a message truncated before its payload ends", () => {
    // A valid text record's header/lengths/type say 8 payload bytes follow, but
    // only 4 are actually present.
    const truncated = "D1 01 08 54 02 65 6E 68";
    expect(() => run(truncated, { kind: "raw-hex-decode" })).toThrowError(/payload/i);
  });

  it("rejects a Wi-Fi record with no Credential attribute", () => {
    const bogusWsc = buildRecord("text", "placeholder");
    // Swap in a MIME record whose payload has no Credential TLV at all.
    const record = { tnf: 0x02, type: "application/vnd.wfa.wsc", payload: Uint8Array.of(0, 0, 0, 0) };
    const bytes = encodeMessage([record]);
    expect(bogusWsc).toBeTruthy();
    expect(() => decodeMessage(bytes)).toThrowError(/Credential/i);
  });
});

describe("ToolError: too-large", () => {
  it("rejects a built message over 8 KB", () => {
    const huge = "a".repeat(9000);
    expect(() => run(huge, { kind: "text" })).toThrowError(/8 KB/i);
  });

  it("rejects raw-hex-decode input over 8 KB", () => {
    const hugeHex = "00".repeat(8200);
    expect(() => run(hugeHex, { kind: "raw-hex-decode" })).toThrowError(/8 KB/i);
  });
});
