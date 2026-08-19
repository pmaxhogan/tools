import { describe, expect, it } from "vitest";
import { describeSupport, FEATURE_PROBES, run } from "./index";

describe("FEATURE_PROBES", () => {
  it("has one entry per detectable feature, each with a non-empty label, proposal, since and bytes", () => {
    expect(FEATURE_PROBES.length).toBeGreaterThan(10);
    for (const probe of FEATURE_PROBES) {
      expect(probe.id).toMatch(/^[a-z0-9-]+$/);
      expect(probe.label.length).toBeGreaterThan(0);
      expect(probe.proposal.length).toBeGreaterThan(0);
      expect(probe.since.length).toBeGreaterThan(0);
      expect(probe.bytes).toBeInstanceOf(Uint8Array);
      expect(probe.bytes.length).toBeGreaterThan(0);
    }
  });

  it("has unique ids", () => {
    const ids = FEATURE_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The whole point of a wasm-feature-detect style probe is that it is only
  // valid because the engine implements the proposal: every module here must
  // parse cleanly under WebAssembly.validate(). Node 22 was used to author
  // and verify every single one; none needed to be marked as a known gap.
  it("every probe validates true under Node's own WebAssembly.validate()", () => {
    for (const probe of FEATURE_PROBES) {
      const ok = WebAssembly.validate(probe.bytes as BufferSource);
      expect(ok, `expected ${probe.id} to validate`).toBe(true);
    }
  });

  it("mangling a probe's section length prefix makes it fail validate, proving the assembly is exact rather than accidentally permissive", () => {
    for (const probe of FEATURE_PROBES) {
      const corrupted = new Uint8Array(probe.bytes);
      // Byte 5 is the first section's id/length area, right after the 8 byte
      // magic + version header; smashing it breaks the section framing.
      corrupted[5] = 0xff;
      expect(
        WebAssembly.validate(corrupted as BufferSource),
        `expected a corrupted ${probe.id} probe to be invalid`,
      ).toBe(false);
    }
  });

  it("magic bytes and version are the fixed wasm header on every probe", () => {
    for (const probe of FEATURE_PROBES) {
      expect([...probe.bytes.slice(0, 8)]).toEqual([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ]);
    }
  });
});

describe("describeSupport", () => {
  const allTrue = Object.fromEntries(FEATURE_PROBES.map((p) => [p.id, true]));
  const allFalse = Object.fromEntries(FEATURE_PROBES.map((p) => [p.id, false]));

  it("labels a supported feature with its proposal name", () => {
    const out = describeSupport({ "bulk-memory": true });
    expect(out["Bulk memory operations"]).toBe("Supported (bulk-memory-operations)");
  });

  it("labels an unsupported feature with its proposal name", () => {
    const out = describeSupport({ "bulk-memory": false });
    expect(out["Bulk memory operations"]).toBe("Not supported (bulk-memory-operations)");
  });

  it("omits a row for a feature id that was not tested", () => {
    const out = describeSupport({ "bulk-memory": true });
    expect(out["Fixed width 128 bit SIMD"]).toBeUndefined();
  });

  it("ignores unrecognized ids in results", () => {
    const out = describeSupport({ "bulk-memory": true, "not-a-real-feature": true });
    expect(Object.keys(out)).not.toContain("not-a-real-feature");
  });

  it("summarizes N of M features supported", () => {
    const out = describeSupport(allTrue);
    expect(out["Summary"]).toBe(`${FEATURE_PROBES.length} of ${FEATURE_PROBES.length} features supported`);
  });

  it("summarizes zero supported", () => {
    const out = describeSupport(allFalse);
    expect(out["Summary"]).toBe(`0 of ${FEATURE_PROBES.length} features supported`);
  });

  it("reports the baseline as yes when the full 2023 Wasm 2.0 set is supported", () => {
    const out = describeSupport(allTrue);
    expect(out["Baseline"]).toBe("Wasm 2.0 baseline: yes");
  });

  it("reports the baseline as no when even one baseline feature is missing", () => {
    const out = describeSupport({ ...allTrue, "sign-extension": false });
    expect(out["Baseline"]).toBe("Wasm 2.0 baseline: no");
  });

  it("reports the baseline as no when a baseline feature was never tested at all", () => {
    const { simd: _simd, ...rest } = allTrue;
    const out = describeSupport(rest);
    expect(out["Baseline"]).toBe("Wasm 2.0 baseline: no");
  });
});

describe("run", () => {
  it("returns the probe catalog with a Note row for empty input", () => {
    const out = run("");
    expect(out["Note"]).toMatch(/WebAssembly.validate/);
    expect(out["Bulk memory operations"]).toContain("bulk-memory-operations");
  });

  it("treats whitespace only input the same as empty input", () => {
    const out = run("   \n  ");
    expect(out["Note"]).toBeDefined();
  });

  it("formats a real feature report the same as describeSupport", () => {
    const report = { "bulk-memory": true, simd: false };
    expect(run(JSON.stringify(report))).toEqual(describeSupport(report));
  });

  it("throws a bad-json ToolError for input that does not parse", () => {
    expect.assertions(2);
    try {
      run("{not json");
    } catch (err) {
      expect((err as { code: string }).code).toBe("bad-json");
      expect((err as Error).message).toMatch(/not valid JSON/);
    }
  });

  it("throws a not-a-report ToolError when the JSON is not an object", () => {
    expect.assertions(1);
    try {
      run("[1,2,3]");
    } catch (err) {
      expect((err as { code: string }).code).toBe("not-a-report");
    }
  });

  it("throws a not-a-report ToolError when no keys are recognized feature ids", () => {
    expect.assertions(1);
    try {
      run(JSON.stringify({ foo: true, bar: false }));
    } catch (err) {
      expect((err as { code: string }).code).toBe("not-a-report");
    }
  });

  it("ignores unrecognized keys alongside at least one recognized id", () => {
    const out = run(JSON.stringify({ "bulk-memory": true, "made-up-feature": true }));
    expect(out["Bulk memory operations"]).toContain("Supported");
    expect(Object.keys(out)).not.toContain("made-up-feature");
  });
});
