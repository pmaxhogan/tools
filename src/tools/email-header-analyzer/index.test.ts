import { describe, expect, it } from "vitest";
import { run, type EmailHeaderOpts } from "./index";
import { ToolError } from "../types";

const DEFAULTS: EmailHeaderOpts = { showRaw: false, section: "all" };
const go = (input: string, opts: Partial<EmailHeaderOpts> = {}): string =>
  run(input, { ...DEFAULTS, ...opts });

/**
 * Realistic five hop message, newest Received first as a real message carries
 * them. Hand computed timeline (all UTC):
 *   hop 1 mail.origin.example  12:00:00  origin
 *   hop 2 smtp.middle.example  12:00:02  +2s
 *   hop 3 mx.dest.example      12:01:06  +64s  -> 1m 4s, the slowest hop
 *   hop 4 store.dest.example   12:01:03  (written as 07:01:03 -0500) -> 3s backwards
 *   hop 5 mbox.dest.example    12:01:11  +8s
 * Total transit 12:00:00 to 12:01:11 = 71s = 1m 11s.
 */
const FIXTURE = [
  "Received: from store.dest.example (store.dest.example [198.51.100.9])",
  "\tby mbox.dest.example (Postfix) with ESMTP id 5E5E5E",
  "\tfor <bob@example.net>; Tue, 5 Aug 2025 12:01:11 +0000 (UTC)",
  "Received: from mx.dest.example by store.dest.example with LMTP id 4D4D4D;",
  "\tTue, 5 Aug 2025 07:01:03 -0500",
  "Received: from smtp.middle.example (helo=smtp.middle.example)",
  "\tby mx.dest.example (Postfix) with ESMTPS id 3C3C3C",
  "\tfor <bob@example.net>; Tue, 5 Aug 2025 12:01:06 +0000",
  "Received: from mail.origin.example (mail.origin.example [203.0.113.44])",
  "\tby smtp.middle.example (Postfix) with ESMTPS id 2B2B2B; Tue, 5 Aug 2025 12:00:02 +0000",
  "Received: by mail.origin.example (Postfix, from userid 1000)",
  "\tid 1A1A1A; Tue, 5 Aug 2025 12:00:00 +0000",
  "Authentication-Results: mx.dest.example;",
  "\tspf=pass (mx.dest.example: domain of bounces@lists.example.org designates 203.0.113.44 as permitted sender) smtp.mailfrom=lists.example.org;",
  "\tdkim=pass header.d=example.com header.s=selector1 header.b=AbCdEf12;",
  '\tdkim=fail reason="body hash did not verify" header.d=news.example.com header.s=mail;',
  "\tdmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
  "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com;",
  "\ts=selector1; h=from:to:subject:date; bh=abc123=; b=sig1data",
  "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=news.example.com;",
  "\ts=mail; h=from:to:subject; bh=def456=; b=sig2data",
  "Return-Path: <bounces+42@lists.example.org>",
  "From: Alice Example <alice@example.com>",
  "To: Bob <bob@example.net>",
  "Reply-To: support@reply.example.net",
  "Subject: Your July invoice",
  "Date: Tue, 5 Aug 2025 12:00:00 +0000",
  "Message-ID: <abc123@example.com>",
  "X-Mailer: Example Mailer 4.2",
  "List-Unsubscribe: <mailto:unsub@lists.example.org>",
  "X-Spam-Status: No, score=-2.1 required=5.0",
  "X-Originating-IP: [203.0.113.44]",
].join("\n");

/** Full .eml: the body repeats header-looking lines that must be ignored. */
const EML = [
  "Received: from mail.origin.example (mail.origin.example [203.0.113.44])",
  "\tby mx.dest.example (Postfix) with ESMTPS id 9F9F9F; Tue, 5 Aug 2025 12:00:05 +0000",
  "From: Alice <alice@example.com>",
  "To: bob@example.net",
  "Subject: Hello",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Received: from evil.example (evil.example [198.51.100.66])",
  "\tby forged.example; Tue, 5 Aug 2025 23:59:59 +0000",
  "Authentication-Results: forged.example; spf=fail smtp.mailfrom=evil.example",
  "",
  "Regards,",
  "Alice",
].join("\n");

const lineFor = (out: string, needle: string): string =>
  out.split("\n").find((l) => l.includes(needle)) ?? "";

describe("email-header-analyzer summary", () => {
  it("lists the standard summary fields", () => {
    const out = go(FIXTURE, { section: "summary" });
    expect(out).toContain("From:");
    expect(out).toContain("Alice Example <alice@example.com>");
    expect(out).toContain("Bob <bob@example.net>");
    expect(out).toContain("Your July invoice");
    expect(out).toContain("Tue, 5 Aug 2025 12:00:00 +0000");
    expect(out).toContain("<abc123@example.com>");
  });

  it("flags a Reply-To domain that differs from the From domain", () => {
    const out = go(FIXTURE, { section: "summary" });
    expect(out).toMatch(/Warning: the Reply-To domain \(reply\.example\.net\)/);
    expect(out).toContain("is not the From domain (example.com)");
  });

  it("reports a Return-Path mismatch honestly rather than as an alarm", () => {
    const out = go(FIXTURE, { section: "summary" });
    const note = lineFor(out, "Return-Path domain");
    expect(note).toContain("lists.example.org");
    expect(note).toContain("normal for mailing lists");
    expect(note).toContain("proves nothing");
  });

  it("does not flag Reply-To when the domains match", () => {
    const input = ["From: Alice <alice@example.com>", "Reply-To: help@example.com"].join("\n");
    expect(go(input, { section: "summary" })).not.toContain("Warning:");
  });
});

describe("email-header-analyzer authentication", () => {
  it("extracts SPF, DMARC and both DKIM signatures with domain and selector", () => {
    const out = go(FIXTURE, { section: "auth" });
    expect(lineFor(out, "SPF")).toContain("pass");
    expect(lineFor(out, "SPF")).toContain("smtp.mailfrom=lists.example.org");
    expect(lineFor(out, "DMARC")).toContain("pass");
    expect(lineFor(out, "DMARC")).toContain("header.from=example.com");
    expect(out).toContain("DKIM signatures (2)");

    const sig1 = lineFor(out, "domain example.com");
    expect(sig1).toContain("selector selector1");
    expect(sig1).toContain("algorithm rsa-sha256");
    expect(sig1).toContain("recorded result: pass");

    const sig2 = lineFor(out, "domain news.example.com");
    expect(sig2).toContain("selector mail");
    expect(sig2).toContain("recorded result: fail");
    expect(sig2).toContain("body hash did not verify");
  });

  it("summarizes two disagreeing DKIM verdicts as mixed", () => {
    const row = lineFor(go(FIXTURE, { section: "auth" }), "DKIM   ");
    expect(row).toContain("mixed");
    expect(row).toContain("2 signatures recorded");
    expect(row).toContain("1 pass");
    expect(row).toContain("1 fail");
  });

  it("keeps the SPF explanation comment attached to the SPF verdict", () => {
    const row = lineFor(go(FIXTURE, { section: "auth" }), "SPF ");
    expect(row).toContain("(mx.dest.example: domain of bounces@lists.example.org designates");
  });

  it("names the recording server and carries the not-re-verified note", () => {
    const out = go(FIXTURE, { section: "auth" });
    expect(out).toContain("Recorded by: mx.dest.example");
    expect(out).toContain("recorded in the headers");
    expect(out).toContain("never re-verifies them");
    expect(out).toContain("DNS lookups this tool does not make");
  });

  it("says no verdicts were recorded instead of guessing when the header is absent", () => {
    const input = [
      "Received: by only.example; Tue, 5 Aug 2025 12:00:00 +0000",
      "From: Alice <alice@example.com>",
      "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel9; b=zz",
    ].join("\n");
    const out = go(input, { section: "auth" });
    expect(out).toContain("No Authentication-Results header is present");
    expect(out).toContain("says nothing about whether the message would pass or fail");
    expect(out).not.toMatch(/^SPF\s/m);
    expect(out).not.toMatch(/^DMARC\s/m);
    expect(out).not.toContain("Recorded by:");
    // The signature is still listed, but with no verdict invented for it.
    const sig = lineFor(out, "domain example.com");
    expect(sig).toContain("selector sel9");
    expect(sig).toContain("recorded result: not recorded for this signature");
  });
});

describe("email-header-analyzer hop waterfall", () => {
  it("orders hops oldest first with hand computed delays", () => {
    const out = go(FIXTURE, { section: "hops" });
    expect(out).toContain("5 Received headers, oldest first");

    const rows = out.split("\n").filter((l) => /^\s*\d+ {2}\S/.test(l));
    // The oldest Received here is a local "by" submission with no from clause,
    // so there is no originating host to put in a hop 0 row.
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("mail.origin.example");
    // The first receiving relay is never labelled as the origin itself: the
    // delay column carries a dash, not the old "origin" marker.
    expect(rows[0]).toMatch(/\s-$/);
    expect(rows[0]).not.toMatch(/origin$/);
    expect(out).not.toContain("Hop 0 is the originating host");
    expect(rows[1]).toContain("smtp.middle.example");
    expect(rows[1]).toContain("2s");
    expect(rows[2]).toContain("mx.dest.example");
    expect(rows[2]).toContain("1m 4s");
    expect(rows[3]).toContain("store.dest.example");
    expect(rows[4]).toContain("mbox.dest.example");
    expect(rows[4]).toContain("8s");
  });

  it("clamps a backwards clock to zero and labels it as skew", () => {
    const rows = go(FIXTURE, { section: "hops" })
      .split("\n")
      .filter((l) => /^\s*\d+ {2}\S/.test(l));
    expect(rows[3]).toContain("0s");
    expect(rows[3]).toContain("clock skew");
    expect(rows[3]).toContain("moved backwards by 3s");
  });

  it("flags the slowest hop and totals the transit time", () => {
    const out = go(FIXTURE, { section: "hops" });
    expect(lineFor(out, "1m 4s")).toContain("<- slowest hop");
    expect(out.match(/<- slowest hop/g)).toHaveLength(1);
    expect(out).toContain("Total transit time: 1m 11s");
  });

  it("parses helo comments and a Received line with no from clause", () => {
    const out = go(FIXTURE, { section: "hops" });
    expect(out).toContain("helo=smtp.middle.example");
    // The origin hop is "Received: by ..." with no from clause at all.
    expect(lineFor(out, " 1. ")).toContain("by mail.origin.example");
    expect(lineFor(out, " 1. ")).not.toContain("from ");
  });

  it("keeps a Received line with no parseable timestamp instead of crashing", () => {
    const input = [
      "Received: from later.example by newest.example; Tue, 5 Aug 2025 12:00:30 +0000",
      "Received: from broken.example by middle.example with ESMTP id NOPE",
      "Received: from origin.example by oldest.example; Tue, 5 Aug 2025 12:00:00 +0000",
      "From: a@example.com",
    ].join("\n");
    const out = go(input, { section: "hops" });
    // Row 0 is the origin row, so the three Received rows start at index 1.
    const rows = out.split("\n").filter((l) => /^\s*\d+ {2}\S/.test(l));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("origin.example");
    expect(rows[2]).toContain("?");
    expect(rows[2]).toContain("no timestamp could be parsed");
    expect(out).toContain("raw: from broken.example by middle.example with ESMTP id NOPE");
    // The chain continues from the last known timestamp.
    expect(rows[3]).toContain("30s");
    expect(out).toContain("Total transit time: 30s");
  });

  it("handles a single Received header", () => {
    const input = [
      "Received: from a.example by b.example; Tue, 5 Aug 2025 12:00:00 +0000",
      "From: a@example.com",
    ].join("\n");
    const out = go(input, { section: "hops" });
    expect(out).toContain("1 Received header, oldest first");
    expect(out).toContain("Only one Received header, so there is no hop to hop delay to measure.");
    expect(out).not.toContain("slowest hop");
  });

  it("opens the waterfall with an origin row naming the from-host and its IP", () => {
    const input = [
      "Received: from relay.two.example by mbox.dest.example; Tue, 5 Aug 2025 12:00:10 +0000",
      "Received: from sender.origin.example (sender.origin.example [203.0.113.44])",
      "\tby relay.two.example (Postfix) with ESMTPS id 7A7A7A; Tue, 5 Aug 2025 12:00:00 +0000",
      "From: a@example.com",
    ].join("\n");
    const rows = go(input, { section: "hops" })
      .split("\n")
      .filter((l) => /^\s*\d+ {2}\S/.test(l));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^\s*0\s/);
    expect(rows[0]).toContain("sender.origin.example");
    expect(rows[0]).toContain("origin");
    expect(rows[0]).toContain("IP 203.0.113.44");
    // Hop 1 is the first receiving relay, not the origin.
    expect(rows[1]).toContain("relay.two.example");
    expect(rows[1]).not.toContain("origin");
    expect(rows[2]).toContain("mbox.dest.example");
    expect(rows[2]).toContain("10s");
  });

  it("omits the origin row when the oldest Received names no from-host", () => {
    const input = [
      "Received: by local.example (Postfix, from userid 1000); Tue, 5 Aug 2025 12:00:00 +0000",
      "From: a@example.com",
    ].join("\n");
    const out = go(input, { section: "hops" });
    const rows = out.split("\n").filter((l) => /^\s*\d+ {2}\S/.test(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^\s*1\s/);
    expect(out).not.toContain("Hop 0 is the originating host");
  });

  it("says so when there is no Received header at all", () => {
    const out = go("Subject: naked\nFrom: a@example.com", { section: "hops" });
    expect(out).toContain("No Received header is present");
  });
});

describe("email-header-analyzer parsing behaviour", () => {
  it("ignores everything after the first blank line of a .eml", () => {
    const out = go(EML);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("forged.example");
    expect(out).toContain("1 Received header, oldest first");
    expect(out).toContain("No Authentication-Results header is present");
  });

  it("matches header names case insensitively", () => {
    const input = [
      "received: by lower.example; Tue, 5 Aug 2025 12:00:00 +0000",
      "FROM: Alice <alice@example.com>",
      "subject: shouting quietly",
      "MESSAGE-ID: <mixed@example.com>",
      "x-mailer: Weird Client 1.0",
    ].join("\n");
    const out = go(input);
    expect(out).toContain("shouting quietly");
    expect(out).toContain("<mixed@example.com>");
    expect(out).toContain("lower.example");
    expect(out).toContain("Weird Client 1.0");
  });

  it("lists the interesting extra headers when present", () => {
    const out = go(FIXTURE);
    expect(out).toContain("X-Mailer:");
    expect(out).toContain("Example Mailer 4.2");
    expect(out).toContain("List-Unsubscribe:");
    expect(out).toContain("X-Spam-Status:");
    expect(out).toContain("X-Originating-IP:");
  });

  it("appends unfolded headers only when showRaw is on", () => {
    expect(go(FIXTURE)).not.toContain("UNFOLDED HEADERS");
    const out = go(FIXTURE, { showRaw: true });
    expect(out).toContain("UNFOLDED HEADERS");
    expect(out).toContain(
      "Received: from smtp.middle.example (helo=smtp.middle.example) by mx.dest.example (Postfix) with ESMTPS id 3C3C3C for <bob@example.net>; Tue, 5 Aug 2025 12:01:06 +0000",
    );
  });

  it("limits output to the requested section", () => {
    const summary = go(FIXTURE, { section: "summary" });
    expect(summary).toContain("SUMMARY");
    expect(summary).not.toContain("AUTHENTICATION");
    expect(summary).not.toContain("HOP WATERFALL");

    const hops = go(FIXTURE, { section: "hops" });
    expect(hops).toContain("HOP WATERFALL");
    expect(hops).not.toContain("SUMMARY");

    const everything = go(FIXTURE);
    expect(everything).toContain("SUMMARY");
    expect(everything).toContain("AUTHENTICATION");
    expect(everything).toContain("HOP WATERFALL");
    expect(everything).toContain("EXTRAS");
  });

  it("tolerates an mbox From line and leading blank lines", () => {
    const input = [
      "",
      "",
      "From alice@example.com Tue Aug  5 12:00:00 2025",
      "From: Alice <alice@example.com>",
      "Subject: mbox export",
    ].join("\n");
    const out = go(input, { section: "summary" });
    expect(out).toContain("Alice <alice@example.com>");
    expect(out).toContain("mbox export");
  });

  it("never emits an em dash or en dash", () => {
    // Escaped rather than literal so a naive dash sweep over this file stays clean.
    expect(go(FIXTURE, { showRaw: true })).not.toMatch(/[\u2014\u2013]/u);
  });
});

describe("email-header-analyzer errors", () => {
  it("throws empty-input on an empty string", () => {
    expect(() => go("")).toThrowError(ToolError);
    try {
      go("   \n  ");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toMatch(/Show original/);
    }
  });

  it("throws no-headers when the input has no header fields", () => {
    expect(() => go("just some prose with no fields at all")).toThrowError(ToolError);
    try {
      go("just some prose with no fields at all");
    } catch (e) {
      expect((e as ToolError).code).toBe("no-headers");
      expect((e as ToolError).fix).toMatch(/Received:/);
    }
  });
});
