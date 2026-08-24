import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const NESTED = JSON.stringify({
  user: { id: 1, tags: ["a", "b"] },
  items: [{ sku: "x", qty: 2 }, { sku: "y" }],
});

describe("json-to-typescript", () => {
  it("generates interfaces for nested objects and array items", () => {
    const out = run(NESTED, { target: "typescript" });
    expect(out).toContain("export interface Root {");
    expect(out).toContain("  user: User;");
    expect(out).toContain("  items: Item[];");
    expect(out).toContain("  tags: string[];");
    // Root is emitted first, nested types after it.
    expect(out.indexOf("export interface Root")).toBeLessThan(out.indexOf("export interface User"));
  });

  it("marks a field missing from one array element as optional in every target", () => {
    expect(run(NESTED, { target: "typescript" })).toContain("  qty?: number;");
    expect(run(NESTED, { target: "zod" })).toContain("  qty: z.number().int().optional(),");
    const kotlin = run(NESTED, { target: "kotlin" });
    expect(kotlin).toContain("val qty: Int? = null");
    expect(kotlin).toContain("val sku: String");
  });

  it("merges conflicting element types into a union", () => {
    const json = JSON.stringify({ values: [{ v: 1 }, { v: "two" }] });
    expect(run(json, { target: "typescript" })).toContain("  v: string | number;");
    expect(run(json, { target: "zod" })).toContain("z.union([z.string(), z.number().int()])");
    const kotlin = run(json, { target: "kotlin" });
    expect(kotlin).toContain("val v: JsonElement");
    expect(kotlin).toContain("mixed types in sample: String, Int");
  });

  it("quotes property names that are not valid identifiers", () => {
    const json = JSON.stringify({ "first-name": "Max", ok: true });
    const ts = run(json, { target: "typescript" });
    expect(ts).toContain('  "first-name": string;');
    expect(ts).toContain("  ok: boolean;");
    expect(run(json, { target: "zod" })).toContain('  "first-name": z.string(),');
  });

  it("declares child zod schemas before the root and exports z.infer types", () => {
    const out = run(NESTED, { target: "zod" });
    expect(out.startsWith('import { z } from "zod";')).toBe(true);
    expect(out.indexOf("const ItemSchema")).toBeLessThan(out.indexOf("const RootSchema"));
    expect(out.indexOf("const UserSchema")).toBeLessThan(out.indexOf("const RootSchema"));
    expect(out).toContain("export type Root = z.infer<typeof RootSchema>;");
    expect(out).toContain("export type Item = z.infer<typeof ItemSchema>;");
  });

  it("uses @SerialName for invalid Kotlin identifiers and picks Int vs Double", () => {
    const json = JSON.stringify({ "first-name": "Max", count: 3, ratio: 1.5, big: 5000000000 });
    const out = run(json, { target: "kotlin" });
    expect(out).toContain("import kotlinx.serialization.SerialName");
    expect(out).toContain("@Serializable");
    expect(out).toContain("data class Root(");
    expect(out).toContain('@SerialName("first-name") val firstName: String');
    expect(out).toContain("val count: Int");
    expect(out).toContain("val ratio: Double");
    expect(out).toContain("val big: Long");
  });

  it("handles a root array", () => {
    const json = JSON.stringify([{ id: 1 }, { id: 2, note: "hi" }]);
    const ts = run(json, { target: "typescript" });
    expect(ts).toContain("export type Root = Item[];");
    expect(ts).toContain("export interface Item {");
    expect(ts).toContain("  note?: string;");
    expect(run(json, { target: "zod" })).toContain(
      "export const RootSchema = z.array(ItemSchema);",
    );
    expect(run(json, { target: "kotlin" })).toContain("typealias Root = List<Item>");
  });

  it("handles a scalar root", () => {
    expect(run('"hello"', { target: "typescript" })).toContain("export type Root = string;");
    expect(run("42", { target: "zod" })).toContain("export const RootSchema = z.number().int();");
    expect(run("true", { target: "kotlin" })).toContain("typealias Root = Boolean");
  });

  it("adds an ISO date-time note without changing the type", () => {
    const json = JSON.stringify({ createdAt: "2026-08-06T21:00:00Z", day: "2026-08-06" });
    const ts = run(json, { target: "typescript" });
    expect(ts).toContain("  createdAt: string; // ISO date-time");
    expect(ts).toContain("  day: string;");
    expect(ts).not.toContain("  day: string; // ISO date-time");
    expect(run(json, { target: "zod" })).toContain('z.string().describe("ISO date-time")');
    expect(run(json, { target: "kotlin" })).toContain("val createdAt: String, // ISO date-time");
  });

  it("treats nulls as optional and nullable, or required when optionalNulls is off", () => {
    const json = JSON.stringify({ nickname: null, email: "a@b.c", deleted: null });
    expect(run(json, { target: "typescript" })).toContain("  nickname?: unknown;");
    expect(run(json, { target: "typescript", optionalNulls: false })).toContain(
      "  nickname: unknown;",
    );
    const mixed = JSON.stringify([{ bio: null }, { bio: "hi" }]);
    expect(run(mixed, { target: "typescript" })).toContain("  bio?: string | null;");
    expect(run(mixed, { target: "typescript", optionalNulls: false })).toContain(
      "  bio: string | null;",
    );
    expect(run(mixed, { target: "zod" })).toContain("z.string().nullable().optional()");
  });

  it("emits unknown[] for an empty array", () => {
    const json = JSON.stringify({ tags: [] });
    expect(run(json, { target: "typescript" })).toContain("  tags: unknown[];");
    expect(run(json, { target: "zod" })).toContain("z.array(z.unknown())");
    const kotlin = run(json, { target: "kotlin" });
    expect(kotlin).toContain("val tags: List<JsonElement>");
    expect(kotlin).toContain("import kotlinx.serialization.json.JsonElement");
  });

  it("honors rootName and de-duplicates colliding type names", () => {
    const json = JSON.stringify({ user: { id: 1 }, users: [{ id: 2 }] });
    const out = run(json, { target: "typescript", rootName: "ApiResponse" });
    expect(out).toContain("export interface ApiResponse {");
    expect(out).toContain("export interface User {");
    expect(out).toContain("export interface User2 {");
  });

  it("throws on invalid JSON with position information", () => {
    expect(() => run('{"a": 1,}', { target: "typescript" })).toThrowError(ToolError);
    try {
      run('{"a": 1,}', { target: "typescript" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-json");
      expect((e as ToolError).message).toMatch(/position/i);
      expect((e as ToolError).fix).toMatch(/trailing commas/);
    }
  });

  it("throws on empty input and on an unknown target", () => {
    expect(() => run("   ", { target: "typescript" })).toThrowError(/Paste a sample JSON/);
    expect(() => run("{}", { target: "rust" })).toThrowError(/Unknown target/);
  });
});
