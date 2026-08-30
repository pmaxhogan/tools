import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSleb128, readUleb128, run } from "./index";
import { ToolError } from "../types";

const SAMPLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../public/samples/sample.wasm",
);

/**
 * Fixtures are hand-built byte arrays so every field under test is visible in
 * the source. Byte layout is commented at each construction site.
 */

/** Magic "\0asm" plus version 1 as a little-endian u32. */
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function mod(...sections: number[][]): Uint8Array {
  return Uint8Array.from([...HEADER, ...sections.flat()]);
}

const OPTS = { view: "summary" };

describe("wasm-inspector", () => {
  it("reads the bare 8 byte module header", () => {
    const out = run(Uint8Array.from(HEADER), OPTS);
    expect(out.Version).toBe("1");
    expect(out.Sections).toBe("none");
    expect(out.Types).toBe("0");
    expect(out.Imports).toBe("none");
    expect(out.Exports).toBe("none");
    expect(out.Memory).toBe("none");
    expect(out.Start).toBe("none");
    expect(out["Features detected"]).toBe("MVP only");
    expect(out.Size).toBe("8 bytes");
  });

  it("parses a memory section", () => {
    // id 5, body size 3, count 1, limits flag 0x00 (min only), min 1 page
    const out = run(mod([0x05, 0x03, 0x01, 0x00, 0x01]), OPTS);
    expect(out.Memory).toBe("#0: initial 1 page, no maximum, not shared");
    expect(out.Sections).toBe("memory (3 bytes)");
    expect(out["Features detected"]).toBe("MVP only");
  });

  it("flags shared memory as the threads proposal", () => {
    // id 5, body size 4, count 1, limits flag 0x03 (shared + max), min 1, max 2
    const out = run(mod([0x05, 0x04, 0x01, 0x03, 0x01, 0x02]), OPTS);
    expect(out.Memory).toBe("#0: initial 1 page, max 2 pages, shared");
    expect(out["Features detected"]).toContain("Threads / shared memory");
  });

  it("flags two memories as the multiple memories proposal", () => {
    // id 5, body size 5, count 2, then two min-only limits of 1 page each
    const out = run(mod([0x05, 0x05, 0x02, 0x00, 0x01, 0x00, 0x01]), OPTS);
    expect(out["Features detected"]).toContain("Multiple memories");
  });

  it("flags a data count section as bulk memory", () => {
    // id 12 (data count), body size 1, value 0
    const out = run(mod([0x0c, 0x01, 0x00]), OPTS);
    expect(out["Features detected"]).toBe("Bulk memory");
  });

  it("detects multi-value and SIMD from a function signature", () => {
    // id 1, body size 6, count 1, 0x60 functype, 0 params,
    // 2 results: v128 (0x7b) and i32 (0x7f)
    const out = run(mod([0x01, 0x06, 0x01, 0x60, 0x00, 0x02, 0x7b, 0x7f]), OPTS);
    expect(out.Types).toBe("1");
    expect(out["Features detected"]).toContain("Multi-value");
    expect(out["Features detected"]).toContain("SIMD");
    expect(out["Features detected"]).not.toContain("heuristic");
  });

  it("never guesses features from raw code section bytes", () => {
    // id 10 (code), body size 5, count 1, body bytes that include 0xfd and 0x12.
    // Those bytes collide with ordinary LEB immediates, so a byte scan would
    // wrongly report SIMD and tail calls. Definitive-only detection reports
    // neither, and nothing is ever labeled "heuristic".
    const out = run(mod([0x0a, 0x05, 0x01, 0x02, 0xfd, 0x0c, 0x12]), OPTS);
    expect(out["Features detected"]).not.toContain("heuristic");
    expect(out["Features detected"]).not.toContain("SIMD");
    expect(out["Features detected"]).not.toContain("Tail calls");
  });

  it("parses imports and exports", () => {
    const imports = [
      // id 2, body size 11: count 1, "env" (3 bytes), "log" (3 bytes),
      // kind 0x00 (func), type index 0
      0x02, 0x0b, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x6c, 0x6f, 0x67, 0x00, 0x00,
    ];
    const exports = [
      // id 7, body size 7: count 1, "mem" (3 bytes), kind 0x02 (memory), index 0
      0x07, 0x07, 0x01, 0x03, 0x6d, 0x65, 0x6d, 0x02, 0x00,
    ];
    const out = run(mod(imports, exports), OPTS);
    expect(out.Imports).toBe("1: env.log (func)");
    expect(out.Exports).toBe("1: mem (memory 0)");
  });

  it("reads the name of a custom section", () => {
    // id 0 (custom), body size 5, name length 4, "name"
    const out = run(mod([0x00, 0x05, 0x04, 0x6e, 0x61, 0x6d, 0x65]), OPTS);
    expect(out.Sections).toBe('custom "name" (5 bytes)');
  });

  it("lists every section with size and offset in the sections view", () => {
    const out = run(mod([0x05, 0x03, 0x01, 0x00, 0x01], [0x0c, 0x01, 0x00]), {
      view: "sections",
    });
    expect(out.Module).toBe("version 1, 16 bytes");
    expect(out["#1 memory"]).toBe("id 5, 3 bytes, body at offset 10");
    expect(out["#2 data count"]).toBe("id 12, 1 byte, body at offset 15");
  });

  it("lists full import and export rows in the symbols view", () => {
    const imports = [0x02, 0x0b, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x6c, 0x6f, 0x67, 0x00, 0x00];
    const exports = [0x07, 0x07, 0x01, 0x03, 0x6d, 0x65, 0x6d, 0x02, 0x00];
    const out = run(mod(imports, exports), { view: "symbols" });
    expect(out.Imports).toBe("1");
    expect(out["Import #1"]).toBe("env.log (func), type 0");
    expect(out["Export #1"]).toBe("mem (memory 0)");
  });

  it("decodes base64, hex, and data URL string input identically", () => {
    const expected = run(Uint8Array.from(HEADER), OPTS);
    expect(run("AGFzbQEAAAA=", OPTS)).toEqual(expected);
    expect(run("0061736d01000000", OPTS)).toEqual(expected);
    expect(run("0x0061736D01000000", OPTS)).toEqual(expected);
    expect(run("data:application/wasm;base64,AGFzbQEAAAA=", OPTS)).toEqual(expected);
    expect(run("  AGFzbQ EAAAA=  ", OPTS)).toEqual(expected);
  });

  it("rejects bytes without the wasm magic", () => {
    expect(() => run(Uint8Array.from([1, 2, 3]), OPTS)).toThrowError(ToolError);
    try {
      run(Uint8Array.from([1, 2, 3]), OPTS);
    } catch (e) {
      expect((e as ToolError).code).toBe("not-wasm");
      expect((e as ToolError).fix).toMatch(/\.wasm/);
    }
    expect(() => run("hello world", OPTS)).toThrowError(/does not look like/);
  });

  it("rejects empty input", () => {
    expect(() => run(new Uint8Array(0), OPTS)).toThrowError(ToolError);
    try {
      run("", OPTS);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("rejects a version other than 1", () => {
    // magic plus version 2
    const v2 = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
    try {
      run(v2, OPTS);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("unsupported-version");
    }
  });

  it("reports a truncated module as a ToolError, not a raw range error", () => {
    // a memory section that claims 16 body bytes but supplies none
    try {
      run(mod([0x05, 0x10]), OPTS);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("truncated");
    }
    // a module whose header stops after the magic bytes
    expect(() => run(Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01]), OPTS)).toThrowError(
      ToolError,
    );
  });

  it("reads unsigned LEB128 numbers", () => {
    expect(readUleb128(Uint8Array.from([0x00]), 0)).toEqual({ value: 0, next: 1 });
    expect(readUleb128(Uint8Array.from([0x7f]), 0)).toEqual({ value: 127, next: 1 });
    expect(readUleb128(Uint8Array.from([0x80, 0x01]), 0)).toEqual({ value: 128, next: 2 });
    // 624485, the canonical multi-byte example from the LEB128 spec
    expect(readUleb128(Uint8Array.from([0xe5, 0x8e, 0x26]), 0).value).toBe(624485);
  });

  it("reads signed LEB128 numbers", () => {
    expect(readSleb128(Uint8Array.from([0x00]), 0)).toEqual({ value: 0, next: 1 });
    expect(readSleb128(Uint8Array.from([0x7f]), 0).value).toBe(-1);
    expect(readSleb128(Uint8Array.from([0x3f]), 0).value).toBe(63);
    expect(readSleb128(Uint8Array.from([0x80, 0x7f]), 0).value).toBe(-128);
    // -123456, the canonical signed example from the LEB128 spec
    expect(readSleb128(Uint8Array.from([0xc0, 0xbb, 0x78]), 0).value).toBe(-123456);
  });

  it("throws a ToolError on a LEB128 number that never terminates", () => {
    expect(() => readUleb128(Uint8Array.from([0x80, 0x80]), 0)).toThrowError(ToolError);
  });
});

describe("wasm-inspector: public/samples/sample.wasm (the meta.ts example)", () => {
  it("decodes a memory import and a memory export", () => {
    const bytes = new Uint8Array(readFileSync(SAMPLE_PATH));
    const out = run(bytes, { view: "summary" });
    expect(out.Version).toBe("1");
    expect(out.Imports).toBe("1: env.log (func)");
    expect(out.Exports).toBe("1: mem (memory 0)");
    expect(out.Memory).toBe("#0: initial 1 page, no maximum, not shared");
  });
});
