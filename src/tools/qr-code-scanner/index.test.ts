import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { decodeQr, interpret, run, type ImageInput } from "./index";
import { ToolError } from "../types";

/**
 * Render a payload to a real RGBA buffer the same way a browser canvas would,
 * so the decode path is exercised end to end. Modules are scaled up (jsQR is
 * unreliable at one pixel per module) and wrapped in a four-module quiet zone
 * so the finder patterns are detectable.
 */
function renderToImage(payload: string, scale = 8, quiet = 4, invert = false): ImageInput {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const modules = qr.modules.data;
  const full = size + quiet * 2;
  const width = full * scale;
  const height = width;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const inRange = mx >= 0 && my >= 0 && mx < size && my < size;
      const dark = inRange ? modules[my * size + mx] === 1 : false;
      const on = invert ? !dark : dark;
      const shade = on ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = shade;
      data[i + 1] = shade;
      data[i + 2] = shade;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** A blank white image with no code in it. */
function blankImage(side = 100): ImageInput {
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  return { data, width: side, height: side };
}

describe("qr-code-scanner: decoding", () => {
  it("round-trips a plain text payload through the pixel buffer", () => {
    const result = decodeQr(renderToImage("hello world"));
    expect(result.text).toBe("hello world");
    expect(result.kind).toBe("text");
    expect(result.label).toBe("Plain text");
  });

  it("decodes a URL and marks it as a safe web link", () => {
    const result = decodeQr(renderToImage("https://example.com/path?a=1"));
    expect(result.kind).toBe("url");
    expect(result.url).toBe("https://example.com/path?a=1");
  });

  it("decodes an inverted (light on dark) code when attempting both", () => {
    const result = decodeQr(renderToImage("inverted code", 8, 4, true), {
      inversion: "attemptBoth",
    });
    expect(result.text).toBe("inverted code");
  });

  it("throws no-qr-found on a blank image", () => {
    expect(() => decodeQr(blankImage())).toThrowError(ToolError);
    expect(() => decodeQr(blankImage())).toThrowError(/No QR code was found/);
  });

  it("throws on a pixel buffer whose length does not match the size", () => {
    const bad: ImageInput = { data: new Uint8ClampedArray(10), width: 100, height: 100 };
    expect(() => decodeQr(bad)).toThrowError(ToolError);
    expect(() => decodeQr(bad)).toThrowError(/does not match the image size/);
  });

  it("throws on non-integer or empty dimensions", () => {
    expect(() => decodeQr({ data: new Uint8ClampedArray(4), width: 1.5, height: 1 })).toThrowError(
      /could not be read as pixels/,
    );
    expect(() => decodeQr({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toThrowError(
      /no width or height/,
    );
  });

  it("flattens the decoded result to a labelled record via run", () => {
    const record = run(renderToImage("https://example.com"), { inversion: "attemptBoth" });
    expect(record.Type).toBe("Web link");
    expect(record.Text).toBe("https://example.com");
  });
});

describe("qr-code-scanner: interpretation", () => {
  it("parses a Wi-Fi payload with escaped reserved characters", () => {
    const result = interpret("WIFI:T:WPA;S:my\\;net;P:p\\:w\\,d;H:true;;");
    expect(result.kind).toBe("wifi");
    expect(result.fields).toEqual([
      { label: "Network name", value: "my;net" },
      { label: "Password", value: "p:w,d" },
      { label: "Security", value: "WPA" },
      { label: "Hidden network", value: "Yes" },
    ]);
    // A Wi-Fi payload is never a clickable link.
    expect(result.url).toBeUndefined();
  });

  it("labels an open Wi-Fi network and omits the password row", () => {
    const result = interpret("WIFI:T:nopass;S:Cafe Guest;;");
    expect(result.fields).toEqual([
      { label: "Network name", value: "Cafe Guest" },
      { label: "Security", value: "Open (no password)" },
    ]);
  });

  it("parses a geo URI into latitude and longitude", () => {
    const result = interpret("geo:38.627,-90.199");
    expect(result.kind).toBe("geo");
    expect(result.fields).toEqual([
      { label: "Latitude", value: "38.627" },
      { label: "Longitude", value: "-90.199" },
    ]);
  });

  it("parses a mailto URL with subject and body and keeps it clickable", () => {
    const result = interpret("mailto:ada@example.com?subject=Hi%20there&body=Line%20one");
    expect(result.kind).toBe("email");
    expect(result.url).toBe("mailto:ada@example.com?subject=Hi%20there&body=Line%20one");
    expect(result.fields).toEqual([
      { label: "To", value: "ada@example.com" },
      { label: "Subject", value: "Hi there" },
      { label: "Message", value: "Line one" },
    ]);
  });

  it("parses tel and SMSTO payloads", () => {
    const tel = interpret("tel:+15550100");
    expect(tel.kind).toBe("phone");
    expect(tel.url).toBe("tel:+15550100");
    expect(tel.fields).toEqual([{ label: "Number", value: "+15550100" }]);

    const sms = interpret("SMSTO:+15550100:on my way");
    expect(sms.kind).toBe("sms");
    expect(sms.fields).toEqual([
      { label: "Number", value: "+15550100" },
      { label: "Message", value: "on my way" },
    ]);
  });

  it("parses a folded vCard into contact fields", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "N:Lovelace;Ada;;;",
      "FN:Ada Lovelace",
      "ORG:Analytical Co",
      "TITLE:Chief Engineer",
      "TEL;TYPE=cell:+15550100",
      "EMAIL:ada@example.com",
      "ADR;TYPE=work:;;12 Bleep St\\, London;;;;",
      "END:VCARD",
    ].join("\r\n");
    const result = interpret(vcard);
    expect(result.kind).toBe("vcard");
    expect(result.fields).toEqual([
      { label: "Name", value: "Ada Lovelace" },
      { label: "Organization", value: "Analytical Co" },
      { label: "Job title", value: "Chief Engineer" },
      { label: "Phone", value: "+15550100" },
      { label: "Email", value: "ada@example.com" },
      { label: "Address", value: "12 Bleep St, London" },
    ]);
  });

  it("parses a VEVENT into a readable schedule", () => {
    const event = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "SUMMARY:Team standup",
      "DTSTART:20260806T090000Z",
      "DTEND:20260806T093000Z",
      "LOCATION:Room 3",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const result = interpret(event);
    expect(result.kind).toBe("event");
    expect(result.fields).toEqual([
      { label: "Title", value: "Team standup" },
      { label: "Starts", value: "2026-08-06 09:00:00 UTC" },
      { label: "Ends", value: "2026-08-06 09:30:00 UTC" },
      { label: "Location", value: "Room 3" },
    ]);
  });

  it("never marks a javascript: or data: payload as a clickable link", () => {
    const js = interpret("javascript:alert(1)");
    expect(js.kind).toBe("text");
    expect(js.url).toBeUndefined();

    const data = interpret("data:text/html,<script>alert(1)</script>");
    expect(data.kind).toBe("text");
    expect(data.url).toBeUndefined();
  });

  it("unfolds continuation lines in a long note before parsing", () => {
    const vcard = ["BEGIN:VCARD", "FN:Ada", "NOTE:line one", " still line one", "END:VCARD"].join(
      "\r\n",
    );
    const result = interpret(vcard);
    expect(result.fields).toContainEqual({ label: "Note", value: "line onestill line one" });
  });
});
