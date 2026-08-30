import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run } from "./index";

/** The Goessner store document every JSONPath implementation is measured against. */
const STORE = {
  store: {
    book: [
      {
        category: "reference",
        author: "Nigel Rees",
        title: "Sayings of the Century",
        price: 8.95,
      },
      {
        category: "fiction",
        author: "Evelyn Waugh",
        title: "Sword of Honor",
        price: 12.99,
      },
      {
        category: "fiction",
        author: "Herman Melville",
        title: "Moby Dick",
        isbn: "0-553-21311-3",
        price: 8.99,
      },
      {
        category: "fiction",
        author: "J. R. R. Tolkien",
        title: "The Lord of the Rings",
        isbn: "0-395-19395-8",
        price: 22.99,
      },
    ],
    bicycle: { color: "red", price: 19.95 },
  },
  expensive: 10,
};

const DOC = JSON.stringify(STORE);

function query(path: string, opts: Record<string, unknown> = {}): Record<string, string> {
  return run(DOC, { path, ...opts });
}

/** The selected values, always as an array (unwrapping off). */
function selected(path: string, doc = DOC): unknown[] {
  const out = run(doc, { path, unwrap: false });
  return JSON.parse(out["Result"] ?? "[]") as unknown[];
}

function paths(path: string, doc = DOC): string[] {
  const listed = run(doc, { path })["Paths"] ?? "";
  return listed === "(none)" ? [] : listed.split("\n");
}

/** Run and return the ToolError it threw, failing the test if it did not throw. */
function caught(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected a ToolError, but the call succeeded");
}

describe("jsonpath-query selectors", () => {
  it("follows a dot child chain and reports the normalized path", () => {
    const out = query("$.store.bicycle.color");
    expect(out["Matches"]).toBe("1 match");
    expect(out["Paths"]).toBe("$['store']['bicycle']['color']");
    expect(out["Result"]).toBe('"red"');
    expect(out["Expression"]).toBe("$.store.bicycle.color");
  });

  it("follows a bracket child chain in single and double quotes", () => {
    expect(selected("$['store']['book'][0]['title']")).toEqual(["Sayings of the Century"]);
    expect(selected('$["store"]["bicycle"]["price"]')).toEqual([19.95]);
  });

  it("returns the whole document for a bare root", () => {
    expect(selected("$")).toEqual([STORE]);
  });

  it("expands a wildcard over object members and over array items", () => {
    expect(paths("$.store.*")).toEqual(["$['store']['book']", "$['store']['bicycle']"]);
    expect(selected("$.store.book[*].author")).toEqual([
      "Nigel Rees",
      "Evelyn Waugh",
      "Herman Melville",
      "J. R. R. Tolkien",
    ]);
  });

  it("walks the whole tree with recursive descent", () => {
    expect(selected("$..author")).toEqual([
      "Nigel Rees",
      "Evelyn Waugh",
      "Herman Melville",
      "J. R. R. Tolkien",
    ]);
    expect(selected("$..book[2].title")).toEqual(["Moby Dick"]);
    expect(paths("$..bicycle.color")).toEqual(["$['store']['bicycle']['color']"]);
  });

  it("lists every node under $..* including the root children", () => {
    const all = paths("$..*");
    expect(all).toContain("$['expensive']");
    expect(all).toContain("$['store']['book'][3]['isbn']");
    expect(all.length).toBeGreaterThan(20);
  });

  it("reads a positive and a negative array index", () => {
    expect(selected("$.store.book[1].title")).toEqual(["Sword of Honor"]);
    expect(selected("$.store.book[-1].title")).toEqual(["The Lord of the Rings"]);
    expect(selected("$.store.book[-4].title")).toEqual(["Sayings of the Century"]);
    expect(selected("$.store.book[9]")).toEqual([]);
  });

  it("handles every slice form", () => {
    expect(selected("$.store.book[1:3].title")).toEqual(["Sword of Honor", "Moby Dick"]);
    expect(selected("$.store.book[:2].title")).toEqual([
      "Sayings of the Century",
      "Sword of Honor",
    ]);
    expect(selected("$.store.book[2:].title")).toEqual(["Moby Dick", "The Lord of the Rings"]);
    expect(selected("$.store.book[::2].title")).toEqual(["Sayings of the Century", "Moby Dick"]);
    expect(selected("$.store.book[-2:].title")).toEqual(["Moby Dick", "The Lord of the Rings"]);
    expect(selected("$.store.book[:-2].title")).toEqual([
      "Sayings of the Century",
      "Sword of Honor",
    ]);
    expect(selected("$.store.book[::-1].title")).toEqual([
      "The Lord of the Rings",
      "Moby Dick",
      "Sword of Honor",
      "Sayings of the Century",
    ]);
    expect(selected("$.store.book[3:1:-1].title")).toEqual(["The Lord of the Rings", "Moby Dick"]);
  });

  it("selects a union of indexes and a union of names", () => {
    expect(selected("$.store.book[0,2].title")).toEqual(["Sayings of the Century", "Moby Dick"]);
    expect(selected("$.store.bicycle['color','price']")).toEqual(["red", 19.95]);
  });
});

describe("jsonpath-query filters", () => {
  it("supports every comparison operator", () => {
    expect(selected("$..book[?(@.price < 10)].title")).toEqual([
      "Sayings of the Century",
      "Moby Dick",
    ]);
    expect(selected("$..book[?(@.price <= 8.95)].title")).toEqual(["Sayings of the Century"]);
    expect(selected("$..book[?(@.price > 20)].title")).toEqual(["The Lord of the Rings"]);
    expect(selected("$..book[?(@.price >= 12.99)].title")).toEqual([
      "Sword of Honor",
      "The Lord of the Rings",
    ]);
    expect(selected("$..book[?(@.category == 'reference')].title")).toEqual([
      "Sayings of the Century",
    ]);
    expect(selected('$..book[?(@.category != "fiction")].title')).toEqual([
      "Sayings of the Century",
    ]);
  });

  it("compares against true, false, and null literals", () => {
    const doc = '[{"n":"a","ok":true},{"n":"b","ok":false},{"n":"c","ok":null}]';
    expect(selected("$[?(@.ok == true)].n", doc)).toEqual(["a"]);
    expect(selected("$[?(@.ok == false)].n", doc)).toEqual(["b"]);
    expect(selected("$[?(@.ok == null)].n", doc)).toEqual(["c"]);
  });

  it("treats existence as selects something, not as truthiness", () => {
    expect(selected("$..book[?(@.isbn)].title")).toEqual(["Moby Dick", "The Lord of the Rings"]);
    const doc = '[{"a":0},{"a":false},{"a":""},{"b":1}]';
    expect(selected("$[?(@.a)]", doc)).toEqual([{ a: 0 }, { a: false }, { a: "" }]);
  });

  it("treats a missing path as true only for the != operator", () => {
    // Nothing != 8.95 is true (RFC 9535), so the book with no price survives.
    const doc = '[{"t":"has","price":8.95},{"t":"none"}]';
    expect(selected("$[?(@.price != 8.95)].t", doc)).toEqual(["none"]);
    expect(selected("$[?(@.price == 8.95)].t", doc)).toEqual(["has"]);
    expect(selected("$[?(@.price < 100)].t", doc)).toEqual(["has"]);
  });

  it("matches a regular expression literal with =~", () => {
    expect(selected("$..book[?(@.author =~ /^Herman/)].title")).toEqual(["Moby Dick"]);
    expect(selected("$..book[?(@.author =~ /waugh/i)].title")).toEqual(["Sword of Honor"]);
    expect(selected("$..book[?(@.author =~ /zzz/)].title")).toEqual([]);
  });

  it("combines tests with &&, ||, ! and parentheses", () => {
    expect(selected("$..book[?(@.category == 'fiction' && @.price < 10)].title")).toEqual([
      "Moby Dick",
    ]);
    expect(selected("$..book[?(@.price < 9 || @.price > 20)].title")).toEqual([
      "Sayings of the Century",
      "Moby Dick",
      "The Lord of the Rings",
    ]);
    expect(selected("$..book[?(!@.isbn)].title")).toEqual([
      "Sayings of the Century",
      "Sword of Honor",
    ]);
    expect(
      selected("$..book[?((@.price < 9 || @.price > 20) && @.category == 'fiction')].title"),
    ).toEqual(["Moby Dick", "The Lord of the Rings"]);
  });

  it("filters on the bare current item and on a relative recursive path", () => {
    expect(selected("$.n[?(@ > 4)]", '{"n":[1,5,10]}')).toEqual([5, 10]);
    const nested = '{"items":[{"meta":{"tag":"x"}},{"meta":{"tag":"y"}}]}';
    expect(selected("$.items[?(@..tag == 'x')]", nested)).toEqual([{ meta: { tag: "x" } }]);
    expect(selected("$.items[?(@['meta'])]", nested).length).toBe(2);
  });

  it("filters object members as well as array items", () => {
    expect(paths("$.store[?(@.price)]")).toEqual(["$['store']['bicycle']"]);
  });
});

describe("jsonpath-query output", () => {
  it("reports a clean empty result when nothing matches", () => {
    const out = query("$..book[?(@.price > 100)]");
    expect(out["Matches"]).toBe("No matches");
    expect(out["Paths"]).toBe("(none)");
    expect(out["Result"]).toBe("[]");
    expect(out["Truncated"]).toBeUndefined();
  });

  it("unwraps a single match only when the option is on", () => {
    expect(query("$.expensive")["Result"]).toBe("10");
    expect(query("$.expensive", { unwrap: false })["Result"]).toBe("[\n  10\n]");
    expect(query("$.expensive", { unwrap: "false" })["Result"]).toBe("[\n  10\n]");
  });

  it("honors the indent option, including a compact zero", () => {
    expect(query("$.store.bicycle", { indent: 0 })["Result"]).toBe('{"color":"red","price":19.95}');
    expect(query("$.store.bicycle", { indent: "4" })["Result"]).toContain('\n    "color"');
    expect(query("$.store.bicycle", { indent: 99 })["Result"]).toContain('\n        "color"');
  });

  it("escapes quotes and backslashes in a normalized path", () => {
    expect(paths("$..*", '{"it\'s":1}')).toEqual(["$['it\\'s']"]);
    expect(paths("$..*", '{"a\\\\b":1}')).toEqual(["$['a\\\\b']"]);
  });

  it("caps the report and says so", () => {
    const big = JSON.stringify(Array.from({ length: 6000 }, (_, i) => i));
    const out = run(big, { path: "$[*]" });
    expect(out["Matches"]).toBe("6000 matches");
    expect(out["Truncated"]).toBe("Only the first 5000 matches are listed, out of 6000 found.");
    expect((out["Paths"] ?? "").split("\n").length).toBe(5000);
  });

  it("walks a deeply nested document without overflowing the stack", () => {
    let doc = '{"leaf":42}';
    for (let i = 0; i < 500; i++) doc = `{"a":${doc}}`;
    const out = run(doc, { path: "$..leaf" });
    expect(out["Matches"]).toBe("1 match");
    expect(out["Result"]).toBe("42");
    expect(out["Paths"]).toBe(`$${"['a']".repeat(500)}['leaf']`);
  });
});

describe("jsonpath-query errors", () => {
  it("rejects an empty document", () => {
    const err = caught(() => run("   ", { path: "$" }));
    expect(err.code).toBe("empty-input");
    expect(err.fix).toBeTruthy();
  });

  it("rejects invalid JSON and passes the parser hint through", () => {
    const err = caught(() => run("{oops", { path: "$" }));
    expect(err.code).toBe("invalid-json");
    expect(err.message).toContain("not valid JSON");
    expect(err.fix).toContain("The JSON parser reported:");
  });

  it("rejects an empty expression", () => {
    const err = caught(() => run(DOC, { path: "  " }));
    expect(err.code).toBe("empty-path");
    expect(caught(() => run(DOC, {})).code).toBe("empty-path");
  });

  it("rejects an expression that does not start with $", () => {
    const err = caught(() => query("store.book"));
    expect(err.code).toBe("bad-root");
    expect(err.message).toContain("start with $");
  });

  it("reports the character index of a path syntax error", () => {
    const stray = caught(() => query("$.store.book)"));
    expect(stray.code).toBe("bad-path");
    expect(stray.message).toContain("at character 12");

    const dangling = caught(() => query("$.store."));
    expect(dangling.code).toBe("bad-path");
    expect(dangling.message).toContain("Expected a property name");

    const junk = caught(() => query("$.store[&]"));
    expect(junk.code).toBe("bad-path");
    expect(junk.message).toContain("Expected an index");
  });

  it("rejects an unterminated bracket, quote, or filter", () => {
    expect(caught(() => query("$.store.book[")).message).toContain("Unterminated bracket");
    expect(caught(() => query("$.store.book[0,1")).message).toContain("Unterminated bracket");
    expect(caught(() => query("$['store")).message).toContain("Unterminated quoted string");
    const openFilter = caught(() => query("$.store.book[?(@.price < 10)"));
    expect(openFilter.code).toBe("bad-filter");
    expect(openFilter.message).toContain('Expected "]"');
  });

  it("rejects a slice step of zero", () => {
    const err = caught(() => query("$.store.book[::0]"));
    expect(err.code).toBe("bad-path");
    expect(err.message).toContain("step of 0");
  });

  it("reports a syntax error inside a filter", () => {
    const missingValue = caught(() => query("$.store.book[?(@.price <)]"));
    expect(missingValue.code).toBe("bad-filter");
    expect(missingValue.message).toContain("Expected a number");

    const missingAt = caught(() => query("$.store.book[?(price < 10)]"));
    expect(missingAt.code).toBe("bad-filter");
    expect(missingAt.message).toContain('starts with "@"');

    const singleEquals = caught(() => query("$.store.book[?(@.price = 10)]"));
    expect(singleEquals.code).toBe("bad-filter");
    expect(singleEquals.message).toContain('Use "=="');

    const badWord = caught(() => query("$.store.book[?(@.price == yes)]"));
    expect(badWord.code).toBe("bad-filter");
    expect(badWord.message).toContain("true, false, or null");

    const openGroup = caught(() => query("$.store.book[?((@.price < 10]"));
    expect(openGroup.code).toBe("bad-filter");
    expect(openGroup.message).toContain('Expected ")"');
  });

  it("rejects a malformed regular expression literal", () => {
    const unterminated = caught(() => query("$..book[?(@.author =~ /^Herman)]"));
    expect(unterminated.code).toBe("bad-filter");
    expect(unterminated.message).toContain("Unterminated regular expression");

    const notARegex = caught(() => query("$..book[?(@.author =~ 'Herman')]"));
    expect(notARegex.code).toBe("bad-filter");
    expect(notARegex.message).toContain("regular expression");

    const broken = caught(() => query("$..book[?(@.author =~ /[/)]"));
    expect(broken.code).toBe("bad-filter");
    expect(broken.message).toContain("not valid");
  });
});
