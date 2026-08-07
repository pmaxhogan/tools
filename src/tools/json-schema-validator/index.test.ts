import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const opts = { draft: "2020-12", shortCircuit: false };

function wrap(schema: unknown, data: unknown): string {
  return JSON.stringify({ schema, data });
}

describe("json-schema-validator", () => {
  it("returns Valid for a document that matches its schema", () => {
    const out = run(wrap({ type: "object", required: ["name"] }, { name: "Ada" }), opts);
    expect(out.Result).toBe("Valid");
    expect(Object.keys(out)).toEqual(["Result"]);
  });

  it("reports the right instance path for a required-property failure", () => {
    const out = run(wrap({ type: "object", required: ["name"] }, { age: 3 }), opts);
    expect(out.Result).toBe("Invalid (1 error)");
    expect(out["#"]).toMatch(/required property "name"/);
    expect(out["#"]).toMatch(/keyword: required/);
  });

  it("reports the indexed path for a type mismatch inside a nested array", () => {
    const schema = {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "number" } },
      },
    };
    const out = run(wrap(schema, { items: [1, "x", 3] }), opts);
    expect(out.Result).toBe("Invalid (1 error)");
    expect(out["#/items/1"]).toBeDefined();
    expect(out["#/items/1"]).toMatch(/type/);
    // The wrapper errors (properties, items) must be filtered out.
    expect(out["#"]).toBeUndefined();
    expect(out["#/items"]).toBeUndefined();
  });

  it("produces leaf errors for a oneOf failure, not just the oneOf wrapper", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
    const out = run(wrap(schema, true), opts);
    expect(out.Result).toBe("Invalid (2 errors)");
    // Both branch-specific leaf errors show up, keyed under '#' with a suffix
    // to dedupe, and neither is the generic oneOf wrapper message.
    expect(out["#"]).toMatch(/type/);
    expect(out["# (2)"]).toMatch(/type/);
    for (const [key, value] of Object.entries(out)) {
      if (key === "Result") continue;
      expect(value).not.toMatch(/does not match exactly one subschema/);
    }
  });

  it("validates draft-7-only $ref-with-siblings behavior when draft is 7", () => {
    const schema = {
      $defs: { str: { type: "string" } },
      $ref: "#/$defs/str",
      // In draft 7, sibling keywords next to $ref are ignored, so this
      // minLength is never enforced. In 2019-09/2020-12 it would be.
      minLength: 100,
    };
    const draft7Out = run(wrap(schema, "ok"), { draft: "7", shortCircuit: false });
    expect(draft7Out.Result).toBe("Valid");

    const draft202012Out = run(wrap(schema, "ok"), { draft: "2020-12", shortCircuit: false });
    expect(draft202012Out.Result).toMatch(/^Invalid/);
  });

  it("throws invalid-json for malformed JSON", () => {
    expect(() => run("{not json", opts)).toThrowError(ToolError);
    try {
      run("{not json", opts);
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-json");
    }
  });

  it('throws missing-key when "data" is absent', () => {
    expect(() => run(JSON.stringify({ schema: { type: "string" } }), opts)).toThrowError(ToolError);
    try {
      run(JSON.stringify({ schema: { type: "string" } }), opts);
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-key");
      expect((e as ToolError).message).toMatch(/"data"/);
      expect((e as ToolError).fix).toMatch(/schema/);
    }
  });

  it('throws missing-key when "schema" is absent', () => {
    try {
      run(JSON.stringify({ data: {} }), opts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("missing-key");
      expect((e as ToolError).message).toMatch(/"schema"/);
    }
  });

  it("throws empty-input for a blank input", () => {
    expect(() => run("", opts)).toThrowError(ToolError);
    try {
      run("   ", opts);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("respects shortCircuit to stop at the first error", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
    };
    const out = run(wrap(schema, { a: 1, b: 2 }), { draft: "2020-12", shortCircuit: true });
    expect(out.Result).toBe("Invalid (1 error)");
  });
});
