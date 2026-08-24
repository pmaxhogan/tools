import { describe, expect, it } from "vitest";
import {
  buildEmail,
  buildEvent,
  buildGeo,
  buildPayload,
  buildPhone,
  buildSms,
  buildVcard,
  buildVcardPayload,
  buildWifi,
  buildWifiPayload,
  contrastRatio,
  effectiveEcc,
  embedLogoInSvg,
  escapeIcal,
  foldLine,
  normaliseColor,
  relativeLuminance,
  renderSvg,
  run,
  scannabilityWarnings,
  toIcalUtc,
} from "./index";
import { ToolError } from "../types";

const OPTS = { preset: "text", ecc: "M", margin: 4 };

/** A 1x1 transparent PNG, small enough to inline in a test. */
const LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("qr-code-generator: rendering", () => {
  it("renders SVG markup with path data", async () => {
    const svg = await run("hello world", OPTS);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toMatch(/<path[^>]*\bd="[^"]+"/);
    expect(svg).toContain("</svg>");
  });

  it("honors error correction and margin options", async () => {
    const low = await run("hello world", { ...OPTS, ecc: "L" });
    const high = await run("hello world", { ...OPTS, ecc: "H" });
    expect(low).not.toBe(high);

    const tight = await run("hello world", { ...OPTS, margin: 0 });
    expect(tight).toMatch(/viewBox="0 0 21 21"/);
  });

  it("renders the requested colors", async () => {
    const svg = await run("hello", { ...OPTS, color: "#112233", background: "#ffeedd" });
    expect(svg).toContain('fill="#ffeedd"');
    expect(svg).toContain('stroke="#112233"');
  });

  it("rejects a bad error correction level", async () => {
    await expect(run("hi", { ...OPTS, ecc: "Z" })).rejects.toThrowError(
      /Unknown error correction level/,
    );
  });

  it("rejects an out-of-range margin", async () => {
    await expect(run("hi", { ...OPTS, margin: -1 })).rejects.toThrowError(/Margin must be/);
    await expect(run("hi", { ...OPTS, margin: 99 })).rejects.toThrowError(ToolError);
  });

  it("rejects a color that is not hex", async () => {
    await expect(run("hi", { ...OPTS, color: "rebeccapurple" })).rejects.toThrowError(
      /is not a hex color/,
    );
  });

  it("wraps over-long input in a typed error", async () => {
    await expect(run("x".repeat(5000), OPTS)).rejects.toThrowError(ToolError);
    await expect(run("x".repeat(5000), OPTS)).rejects.toThrowError(/Could not encode/);
  });

  it("rejects empty input", async () => {
    await expect(run("   ", OPTS)).rejects.toThrowError(ToolError);
    expect(() => buildPayload("", "text")).toThrowError(/Enter the text/);
  });

  it("rejects an unknown preset", () => {
    expect(() => buildPayload("hi", "barcode")).toThrowError(/Unknown preset/);
  });
});

describe("qr-code-generator: url and text", () => {
  it("accepts a valid URL under the url preset", async () => {
    const svg = await run("https://example.com/a?b=c", { ...OPTS, preset: "url" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(buildPayload("https://example.com/a?b=c", "url")).toBe("https://example.com/a?b=c");
  });

  it("rejects an invalid URL under the url preset", async () => {
    await expect(run("not a url", { ...OPTS, preset: "url" })).rejects.toThrowError(ToolError);
    await expect(run("not a url", { ...OPTS, preset: "url" })).rejects.toThrowError(
      /not a valid URL/,
    );
  });
});

describe("qr-code-generator: wifi", () => {
  it("escapes reserved characters in the wifi payload", () => {
    const payload = buildWifiPayload("my;net:work\np@ss,word\nWPA");
    expect(payload).toBe("WIFI:T:WPA;S:my\\;net\\:work;P:p@ss\\,word;;");
  });

  it("escapes a password containing a colon, quotes and a backslash", () => {
    const payload = buildWifi({ ssid: "Cafe", password: 'a:b"c\\d', security: "WPA" });
    expect(payload).toBe('WIFI:T:WPA;S:Cafe;P:a\\:b\\"c\\\\d;;');
  });

  it("omits the password for open wifi networks", () => {
    expect(buildWifiPayload("Cafe Guest\n\nnopass")).toBe("WIFI:T:nopass;S:Cafe Guest;;");
  });

  it("defaults wifi security to WPA and rejects unknown types", () => {
    expect(buildWifiPayload("home\nhunter2")).toBe("WIFI:T:WPA;S:home;P:hunter2;;");
    expect(() => buildWifiPayload("home\nhunter2\nWPA9")).toThrowError(/Unknown Wi-Fi security/);
  });

  it("marks hidden networks only when asked", () => {
    expect(buildWifi({ ssid: "home", password: "x", hidden: true })).toBe(
      "WIFI:T:WPA;S:home;P:x;H:true;;",
    );
    expect(buildWifiPayload("home\nx\nWPA\nhidden")).toBe("WIFI:T:WPA;S:home;P:x;H:true;;");
    expect(buildWifiPayload("home\nx\nWPA\n")).toBe("WIFI:T:WPA;S:home;P:x;;");
  });

  it("requires an SSID for the wifi preset", () => {
    expect(() => buildWifiPayload("\nhunter2\nWPA")).toThrowError(ToolError);
  });
});

describe("qr-code-generator: vcard", () => {
  it("builds a vCard 4.0", async () => {
    const payload = buildVcardPayload("Ada Lovelace\n+1 555 0100\nada@example.com\nAnalytical Co");
    expect(payload.startsWith("BEGIN:VCARD\r\nVERSION:4.0")).toBe(true);
    expect(payload).toContain("N:Lovelace;Ada;;;");
    expect(payload).toContain("FN:Ada Lovelace");
    expect(payload).toContain("TEL;TYPE=cell:+1 555 0100");
    expect(payload).toContain("EMAIL:ada@example.com");
    expect(payload).toContain("ORG:Analytical Co");
    expect(payload.endsWith("END:VCARD")).toBe(true);

    const svg = await run("Ada Lovelace\n+1 555 0100", { ...OPTS, preset: "vcard" });
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("keeps the historic line order and appends the new fields after it", () => {
    const payload = buildVcardPayload(
      [
        "Ada Lovelace",
        "+1 555 0100",
        "ada@example.com",
        "Analytical Co",
        "Chief Engineer",
        "https://example.com",
        "12 Bleep St, London",
        "Met at the fair",
      ].join("\n"),
    );
    expect(payload).toContain("ORG:Analytical Co");
    expect(payload).toContain("TITLE:Chief Engineer");
    expect(payload).toContain("URL:https://example.com");
    expect(payload).toContain("ADR;TYPE=work:;;12 Bleep St\\, London;;;;");
    expect(payload).toContain("NOTE:Met at the fair");
  });

  it("escapes commas and semicolons in vCard values", () => {
    const payload = buildVcardPayload("Grace Hopper\n\n\nNavy; Research, Inc");
    expect(payload).toContain("ORG:Navy\\; Research\\, Inc");
  });

  it("escapes a semicolon inside the contact name", () => {
    const payload = buildVcard({ name: "Ada; Lovelace" });
    expect(payload).toContain("FN:Ada\\; Lovelace");
    expect(payload).toContain("N:Lovelace;Ada\\;;;;");
  });

  it("turns newlines in a note into the escaped sequence", () => {
    const payload = buildVcard({ name: "Ada", note: "line one\nline two" });
    expect(payload).toContain("NOTE:line one\\nline two");
  });

  it("folds a long vCard property at 75 octets", () => {
    const note = "x".repeat(200);
    const payload = buildVcard({ name: "Ada", note });
    const folded = payload.split("\r\n").filter((l) => l.startsWith("NOTE:") || l.startsWith(" "));
    expect(folded[0]).toHaveLength(75);
    expect(folded[1]!.startsWith(" ")).toBe(true);
  });

  it("requires a name for the vcard preset", () => {
    expect(() => buildVcardPayload("\n+1 555 0100")).toThrowError(ToolError);
    expect(() => buildVcard({ name: "  " })).toThrowError(/contact name is required/);
  });
});

describe("qr-code-generator: email, sms, phone", () => {
  it("builds a mailto with encoded subject and body", () => {
    expect(
      buildEmail({ to: "ada@example.com", subject: "Hi there", body: "Line one\nLine two" }),
    ).toBe("mailto:ada@example.com?subject=Hi%20there&body=Line%20one%0ALine%20two");
  });

  it("drops empty mailto parameters", () => {
    expect(buildEmail({ to: "ada@example.com" })).toBe("mailto:ada@example.com");
    expect(buildPayload("ada@example.com\n\n", "email")).toBe("mailto:ada@example.com");
  });

  it("rejects an address without a domain", () => {
    expect(() => buildEmail({ to: "ada" })).toThrowError(/not a valid email address/);
    expect(() => buildEmail({ to: "" })).toThrowError(ToolError);
  });

  it("builds SMSTO payloads with the message left as raw text", () => {
    expect(buildSms({ number: "+1 555 0100", message: "on my way, 5 min" })).toBe(
      "SMSTO:+15550100:on my way, 5 min",
    );
    expect(buildSms({ number: "+15550100" })).toBe("SMSTO:+15550100");
    expect(buildPayload("+1 555 0100\nhello\nthere", "sms")).toBe("SMSTO:+15550100:hello\nthere");
  });

  it("builds a tel URL and rejects a number with letters", () => {
    expect(buildPhone(" +1 (555) 0100 ")).toBe("tel:+1(555)0100");
    expect(() => buildPhone("call me")).toThrowError(/not a usable phone number/);
    expect(() => buildPhone("")).toThrowError(ToolError);
  });
});

describe("qr-code-generator: geo", () => {
  it("builds a geo URI from a pair on one line or two", () => {
    expect(buildPayload("38.627, -90.199", "geo")).toBe("geo:38.627,-90.199");
    expect(buildPayload("38.627\n-90.199", "geo")).toBe("geo:38.627,-90.199");
  });

  it("never emits exponent notation", () => {
    expect(buildGeo({ latitude: 0.0000001, longitude: 0 })).toBe("geo:0.000000,0");
  });

  it("rejects out of range or non numeric coordinates", () => {
    expect(() => buildGeo({ latitude: 91, longitude: 0 })).toThrowError(/Latitude/);
    expect(() => buildGeo({ latitude: 0, longitude: 181 })).toThrowError(/Longitude/);
    expect(() => buildGeo({ latitude: "north", longitude: 0 })).toThrowError(
      /must both be numbers/,
    );
  });
});

describe("qr-code-generator: calendar event", () => {
  it("wraps a VEVENT in a VCALENDAR with UTC basic timestamps", () => {
    const payload = buildEvent({
      summary: "Standup",
      start: "2026-08-06T09:00",
      end: "2026-08-06T09:30",
      location: "Room 3",
    });
    expect(payload.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0")).toBe(true);
    expect(payload).toContain("BEGIN:VEVENT");
    expect(payload).toContain("DTSTART:20260806T090000Z");
    expect(payload).toContain("DTEND:20260806T093000Z");
    expect(payload).toContain("SUMMARY:Standup");
    expect(payload).toContain("LOCATION:Room 3");
    expect(payload).toMatch(/UID:[a-z0-9]+@tools\.maxhogan\.dev/);
    expect(payload).toContain("DTSTAMP:20260806T090000Z");
    expect(payload.endsWith("END:VEVENT\r\nEND:VCALENDAR")).toBe(true);
  });

  it("handles an event that crosses midnight UTC", () => {
    const payload = buildEvent({
      summary: "Launch window",
      start: "2026-08-06T23:30",
      end: "2026-08-07T00:30",
    });
    expect(payload).toContain("DTSTART:20260806T233000Z");
    expect(payload).toContain("DTEND:20260807T003000Z");
  });

  it("is deterministic regardless of the machine timezone", () => {
    expect(toIcalUtc("2026-08-06T23:30")).toBe("20260806T233000Z");
    expect(toIcalUtc("2026-08-06T23:30:00Z")).toBe("20260806T233000Z");
    expect(toIcalUtc("2026-08-06T18:30:00-05:00")).toBe("20260806T233000Z");
    expect(toIcalUtc("20260806T233000Z")).toBe("20260806T233000Z");
    expect(toIcalUtc(new Date(Date.UTC(2026, 7, 6, 23, 30)))).toBe("20260806T233000Z");
  });

  it("escapes commas, semicolons and newlines in text values", () => {
    const payload = buildEvent({
      summary: "Lunch, then a walk",
      start: "2026-08-06T12:00",
      description: "Bring: a coat; an umbrella\nand cash",
    });
    expect(payload).toContain("SUMMARY:Lunch\\, then a walk");
    expect(payload).toContain("DESCRIPTION:Bring: a coat\\; an umbrella\\nand cash");
    expect(escapeIcal("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
  });

  it("defaults the end to the start and rejects a backwards range", () => {
    const payload = buildEvent({ summary: "Ping", start: "2026-08-06T12:00" });
    expect(payload).toContain("DTSTART:20260806T120000Z");
    expect(payload).toContain("DTEND:20260806T120000Z");
    expect(() =>
      buildEvent({ summary: "Ping", start: "2026-08-06T12:00", end: "2026-08-06T11:00" }),
    ).toThrowError(/ends before it starts/);
  });

  it("rejects a missing title and an unreadable date", () => {
    expect(() => buildEvent({ summary: "", start: "2026-08-06T12:00" })).toThrowError(
      /event title is required/,
    );
    expect(() => buildEvent({ summary: "Ping", start: "" })).toThrowError(ToolError);
    expect(() => buildEvent({ summary: "Ping", start: "2026-02-31T12:00" })).toThrowError(
      /not a real date/,
    );
    expect(() => buildEvent({ summary: "Ping", start: "next tuesday" })).toThrowError(
      /not a date and time/,
    );
  });

  it("builds an event from the line based preset", () => {
    const payload = buildPayload(
      "Standup\n2026-08-06T09:00\n2026-08-06T09:30\nRoom 3\nStanding only",
      "event",
    );
    expect(payload).toContain("SUMMARY:Standup");
    expect(payload).toContain("DESCRIPTION:Standing only");
  });
});

describe("qr-code-generator: line folding", () => {
  it("leaves short lines alone", () => {
    expect(foldLine("SUMMARY:hi")).toBe("SUMMARY:hi");
    expect(foldLine("x".repeat(75))).toBe("x".repeat(75));
  });

  it("folds at 75 octets, then 74 per continuation", () => {
    const folded = foldLine("x".repeat(160)).split("\r\n");
    expect(folded[0]).toHaveLength(75);
    expect(folded[1]).toBe(` ${"x".repeat(74)}`);
    expect(folded[2]).toBe(` ${"x".repeat(11)}`);
  });

  it("never splits a multi byte character", () => {
    // 74 ASCII then an e-acute (2 octets): the accented char must move down.
    const folded = foldLine(`${"x".repeat(74)}éé`).split("\r\n");
    expect(folded[0]).toBe("x".repeat(74));
    expect(folded[1]).toBe(" éé");
    // An emoji is 4 octets and one code point: it stays whole too.
    const emoji = foldLine(`${"x".repeat(73)}\u{1F600}\u{1F600}`).split("\r\n");
    expect(emoji[0]).toBe("x".repeat(73));
    expect(emoji[1]).toBe(" \u{1F600}\u{1F600}");
  });
});

describe("qr-code-generator: colors and scannability", () => {
  it("parses short and long hex forms", () => {
    expect(normaliseColor("#fff", "#000000")).toBe("#ffffff");
    expect(normaliseColor("#1D1B18", "#000000")).toBe("#1d1b18");
    expect(normaliseColor("", "#123456")).toBe("#123456");
    expect(() => normaliseColor("blue", "#000000")).toThrowError(/not a hex color/);
  });

  it("computes WCAG luminance and contrast", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("warns about a large logo and about low contrast", () => {
    expect(scannabilityWarnings({})).toEqual([]);
    expect(scannabilityWarnings({ hasLogo: true, logoSize: 0.2 })).toEqual([]);
    expect(scannabilityWarnings({ hasLogo: true, logoSize: 0.25 })[0]).toMatch(/more than 20%/);
    const low = scannabilityWarnings({ color: "#888888", background: "#ffffff" });
    expect(low).toHaveLength(1);
    expect(low[0]).toMatch(/Contrast/);
  });

  it("forces error correction H only when a logo is present", () => {
    expect(effectiveEcc("L", true)).toBe("H");
    expect(effectiveEcc("L", false)).toBe("L");
    expect(effectiveEcc("", false)).toBe("M");
  });
});

describe("qr-code-generator: logo embedding", () => {
  it("centers a padded rounded plate and the image inside the viewBox", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0"/></svg>';
    const out = embedLogoInSvg(svg, { dataUrl: LOGO, size: 0.2, pad: 0.08 });
    // Logo 20 wide, plate 20 * 1.16 = 23.2 wide, both centered in 100.
    expect(out).toContain('<rect x="38.4" y="38.4" width="23.2" height="23.2" rx="3.48"');
    expect(out).toContain('fill="#ffffff"');
    expect(out).toContain('<image x="40" y="40" width="20" height="20"');
    expect(out).toContain(`href="${LOGO}"`);
    expect(out.endsWith("</svg>")).toBe(true);
    expect(out.indexOf("<rect")).toBeLessThan(out.indexOf("<image"));
  });

  it("paints the plate in the background color", () => {
    const svg = '<svg viewBox="0 0 40 40"></svg>';
    expect(embedLogoInSvg(svg, { dataUrl: LOGO, background: "#ffeedd" })).toContain(
      'fill="#ffeedd"',
    );
  });

  it("returns the code untouched when there is no logo", () => {
    const svg = '<svg viewBox="0 0 40 40"></svg>';
    expect(embedLogoInSvg(svg, { dataUrl: "" })).toBe(svg);
  });

  it("refuses a remote logo reference", () => {
    expect(() =>
      embedLogoInSvg('<svg viewBox="0 0 40 40"></svg>', { dataUrl: "https://example.com/l.png" }),
    ).toThrowError(/must be embedded data/);
  });

  it("escapes the data URL before it lands in an attribute", () => {
    const out = embedLogoInSvg('<svg viewBox="0 0 40 40"></svg>', {
      dataUrl: "data:image/svg+xml,%3Csvg%3E?a=1&b=2",
    });
    expect(out).toContain("a=1&amp;b=2");
    expect(out).not.toContain('a=1&b=2"');
  });

  it("embeds the logo through renderSvg and forces H", async () => {
    const plain = await renderSvg("hello", { ecc: "L", margin: 0 });
    const withLogo = await renderSvg("hello", {
      ecc: "L",
      margin: 0,
      logo: { dataUrl: LOGO, size: 0.2 },
    });
    const forcedH = await renderSvg("hello", { ecc: "H", margin: 0 });
    expect(withLogo).toContain("<image");
    expect(plain).not.toContain("<image");
    // The logo path re-encodes at H, so the module pattern matches the H code.
    expect(withLogo.replace(/<rect[^>]*\/><image[^>]*\/>/, "")).toBe(forcedH);
  });
});
