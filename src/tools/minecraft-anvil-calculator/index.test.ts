import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  type AnvilItem,
  type CombineOptions,
  type CombineOutcome,
  combineItems,
  increasedRepairCost,
  planCombine,
  renameOnly,
  repairWithMaterials,
  run,
  sequentialPlan,
  tooExpensiveHorizon,
} from "./index";
import { ANVIL_VERSIONS, ANVIL_VERSION_ORDER } from "./data";

const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "mc-pipeline",
  "vectors",
  "anvil",
  "source-derived.json",
);

interface VectorCase {
  id: string;
  description: string;
  versions: string[];
  target: AnvilItem;
  sacrifice?: AnvilItem;
  materials?: number;
  rename?: "set" | "clear";
  creative?: boolean;
  expect: {
    status: string;
    displayedCost: number;
    work?: number;
    resultEnchants?: Record<string, number>;
    resultPriorWork?: number;
    resultDamage?: number;
    materialsUsed?: number;
    droppedEnchants?: string[];
  };
  provenance: string;
}

const vectors: { cases: VectorCase[] } = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

function runCase(c: VectorCase, version: string): CombineOutcome {
  const opts: CombineOptions = {
    version,
    creative: c.creative === true,
    rename: c.rename ?? "keep",
  };
  if (c.materials !== undefined) return repairWithMaterials(c.target, c.materials, opts);
  if (c.sacrifice) return combineItems(c.target, c.sacrifice, opts);
  return renameOnly(c.target, { ...opts, rename: c.rename ?? "set" });
}

describe("source-derived vectors", () => {
  it("covers at least 40 worked cases", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(40);
  });

  it("every vector version exists in the data set", () => {
    for (const c of vectors.cases) {
      for (const v of c.versions) expect(ANVIL_VERSIONS[v], `${c.id}: ${v}`).toBeDefined();
    }
  });

  for (const c of vectors.cases) {
    for (const version of c.versions) {
      it(`${c.id} [${version}]`, () => {
        const outcome = runCase(c, version);
        expect(outcome.status, "status").toBe(c.expect.status);
        expect(outcome.displayedCost, "displayedCost").toBe(c.expect.displayedCost);
        if (c.expect.work !== undefined) expect(outcome.work, "work").toBe(c.expect.work);
        if (c.expect.resultEnchants) {
          expect(outcome.result, "result expected").not.toBeNull();
          const got: Record<string, number> = {};
          for (const e of outcome.result!.enchants) got[e.id] = e.level;
          expect(got).toEqual(c.expect.resultEnchants);
        }
        if (c.expect.resultPriorWork !== undefined) {
          expect(outcome.result!.priorWork, "resultPriorWork").toBe(c.expect.resultPriorWork);
        }
        if (c.expect.resultDamage !== undefined) {
          expect(outcome.result!.damage, "resultDamage").toBe(c.expect.resultDamage);
        }
        if (c.expect.materialsUsed !== undefined) {
          expect(outcome.materialsUsed, "materialsUsed").toBe(c.expect.materialsUsed);
        }
        if (c.expect.droppedEnchants) {
          expect(outcome.droppedEnchants.sort()).toEqual([...c.expect.droppedEnchants].sort());
        }
        if (c.expect.status === "too-expensive" || c.expect.status === "no-change") {
          expect(outcome.result).toBeNull();
        }
      });
    }
  }
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function fresh(kind: string, extra: Partial<AnvilItem> = {}): AnvilItem {
  return { kind, enchants: [], priorWork: 0, damage: 0, ...extra };
}

function book(...enchants: [string, number][]): AnvilItem {
  return {
    kind: "book",
    enchants: enchants.map(([id, level]) => ({ id, level })),
    priorWork: 0,
    damage: 0,
  };
}

/**
 * Independent brute-force planner: enumerates every merge tree with no
 * memoization or pruning beyond legality, returning the minimum total cost.
 */
function bruteForceMinTotal(
  item: AnvilItem,
  books: AnvilItem[],
  opts: CombineOptions,
): number | null {
  function go(states: AnvilItem[]): number | null {
    if (states.length === 1) return 0;
    let best: number | null = null;
    for (let t = 0; t < states.length; t += 1) {
      for (let s = 0; s < states.length; s += 1) {
        if (t === s || states[s]!.kind !== "book") continue;
        const outcome = combineItems(states[t]!, states[s]!, opts);
        if (outcome.status !== "ok" || !outcome.result) continue;
        const rest = states.filter((_, i) => i !== t && i !== s);
        const sub = go([outcome.result, ...rest]);
        if (sub === null) continue;
        const total = outcome.displayedCost + sub;
        if (best === null || total < best) best = total;
      }
    }
    return best;
  }
  return go([item, ...books]);
}

/* ------------------------------------------------------------------ */
/* prior work + horizon                                                */
/* ------------------------------------------------------------------ */

describe("prior work growth", () => {
  it("follows the 2n+1 sequence", () => {
    let pw = 0;
    const seq = [];
    for (let i = 0; i < 6; i += 1) {
      pw = increasedRepairCost(pw);
      seq.push(pw);
    }
    expect(seq).toEqual([1, 3, 7, 15, 31, 63]);
  });

  it("horizon from a fresh item allows exactly 6 combines", () => {
    const steps = tooExpensiveHorizon(0);
    expect(steps.map((s) => s.priorWorkBefore)).toEqual([0, 1, 3, 7, 15, 31]);
    expect(steps.map((s) => s.maxAffordableWork)).toEqual([39, 38, 36, 32, 24, 8]);
    expect(steps.at(-1)!.priorWorkAfter).toBe(63);
  });

  it("horizon at 39+ is empty (only renames remain possible)", () => {
    expect(tooExpensiveHorizon(39)).toEqual([]);
    expect(tooExpensiveHorizon(63)).toEqual([]);
    const rename = renameOnly(fresh("sword", { priorWork: 63 }), { version: "1.21.11" });
    expect(rename.status).toBe("ok");
    expect(rename.displayedCost).toBe(39);
  });

  it("rejects negative prior work", () => {
    expect(() => tooExpensiveHorizon(-1)).toThrowError(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* planner                                                             */
/* ------------------------------------------------------------------ */

describe("planner", () => {
  const opts: CombineOptions = { version: "1.21.1" };

  it("matches an independent brute force on 3 books", () => {
    const books = [book(["sharpness", 5]), book(["looting", 3]), book(["mending", 1])];
    const plan = planCombine(fresh("sword"), books, opts);
    const brute = bruteForceMinTotal(fresh("sword"), books, opts);
    expect(plan).not.toBeNull();
    expect(plan!.totalCost).toBe(brute);
  });

  it("matches the brute force on 4 books with a conflict present", () => {
    const books = [
      book(["sharpness", 5]),
      book(["smite", 5]),
      book(["unbreaking", 3]),
      book(["mending", 1]),
    ];
    const plan = planCombine(fresh("sword"), books, opts);
    const brute = bruteForceMinTotal(fresh("sword"), books, opts);
    expect(plan).not.toBeNull();
    expect(plan!.totalCost).toBe(brute);
  });

  it("beats the naive sequential order on the 5 book sword build by the exact amount", () => {
    const books = [
      book(["sharpness", 5]),
      book(["looting", 3]),
      book(["unbreaking", 3]),
      book(["mending", 1]),
      book(["fire_aspect", 2]),
    ];
    const naive = sequentialPlan(fresh("sword"), books, opts);
    const plan = planCombine(fresh("sword"), books, opts);
    const brute = bruteForceMinTotal(fresh("sword"), books, opts);
    expect(naive).not.toBeNull();
    expect(plan).not.toBeNull();
    // Naive: work costs 5+6+3+2+4 on prior work 0,1,3,7,15.
    expect(naive!.totalCost).toBe(46);
    expect(plan!.totalCost).toBe(brute);
    // Verified by hand: sword+looting (6), sharpness+unbreaking books (3),
    // sword+that book (2 prior work + 8 fees = 10), fire aspect+mending
    // books (2), sword+that book (4 prior work + 6 fees = 10). Total 31.
    expect(plan!.totalCost).toBe(31);
    expect(plan!.steps.length).toBe(5);
    // The optimal plan still ends with the full kit.
    const final: Record<string, number> = {};
    for (const e of plan!.finalItem.enchants) final[e.id] = e.level;
    expect(final).toEqual({
      sharpness: 5,
      looting: 3,
      unbreaking: 3,
      mending: 1,
      fire_aspect: 2,
    });
    // Every step is survival-affordable.
    for (const s of plan!.steps) expect(s.outcome.displayedCost).toBeLessThan(40);
  });

  it("merges same-level books to reach a higher level than sequential application", () => {
    // Two Sharpness IV books: merging them first yields Sharpness V.
    const plan = planCombine(
      fresh("sword"),
      [book(["sharpness", 4]), book(["sharpness", 4])],
      opts,
    );
    expect(plan).not.toBeNull();
    const final = Object.fromEntries(plan!.finalItem.enchants.map((e) => [e.id, e.level]));
    expect(final).toEqual({ sharpness: 5 });
  });

  it("returns null when no legal plan exists", () => {
    // Sweeping Edge cannot land on an axe and a lone incompatible-only step fails.
    const plan = planCombine(fresh("axe"), [book(["sweeping_edge", 3])], { version: "1.21.1" });
    expect(plan).toBeNull();
  });

  it("returns null for an empty book list", () => {
    expect(planCombine(fresh("sword"), [], opts)).toBeNull();
  });

  it("rejects more than 7 books", () => {
    const books = Array.from({ length: 8 }, () => book(["unbreaking", 3]));
    expect(() => planCombine(fresh("sword"), books, opts)).toThrowError(ToolError);
  });

  it("rejects non-book or empty-book sacrifices", () => {
    expect(() => planCombine(fresh("sword"), [fresh("sword")], opts)).toThrowError(ToolError);
    expect(() => planCombine(fresh("sword"), [book()], opts)).toThrowError(ToolError);
  });

  it("handles the full 7 book god sword search quickly", () => {
    const books = [
      book(["sharpness", 5]),
      book(["looting", 3]),
      book(["unbreaking", 3]),
      book(["mending", 1]),
      book(["fire_aspect", 2]),
      book(["knockback", 2]),
      book(["sweeping_edge", 3]),
    ];
    const start = Date.now();
    const plan = planCombine(fresh("sword"), books, opts);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(plan).not.toBeNull();
    expect(plan!.steps.length).toBe(7);
    for (const s of plan!.steps) expect(s.outcome.displayedCost).toBeLessThan(40);
    const naive = sequentialPlan(fresh("sword"), books, opts);
    expect(naive).toBeNull(); // sequential order goes Too Expensive before finishing
  });
});

/* ------------------------------------------------------------------ */
/* engine edges and errors                                             */
/* ------------------------------------------------------------------ */

describe("engine edges", () => {
  it("rejects unknown versions", () => {
    expect(() =>
      combineItems(fresh("sword"), book(["sharpness", 1]), { version: "1.8" }),
    ).toThrowError(ToolError);
  });

  it("rejects enchantments that do not exist in the chosen version", () => {
    expect(() =>
      combineItems(fresh("sword"), book(["density", 5]), { version: "1.16.5" }),
    ).toThrowError(ToolError);
  });

  it("rejects item families that do not exist in the chosen version", () => {
    expect(() =>
      combineItems(fresh("mace"), book(["unbreaking", 3]), { version: "1.16.5" }),
    ).toThrowError(ToolError);
  });

  it("rejects out-of-range damage", () => {
    expect(() =>
      combineItems(fresh("sword", { damage: 9999 }), book(["sharpness", 1]), { version: "1.21.1" }),
    ).toThrowError(ToolError);
  });

  it("rejects zero repair materials", () => {
    expect(() =>
      repairWithMaterials(fresh("sword", { damage: 100 }), 0, { version: "1.21.1" }),
    ).toThrowError(ToolError);
  });

  it("creative bypasses canEnchant so any book lands on any item", () => {
    // Protection cannot normally land on a sword.
    const survival = combineItems(fresh("sword"), book(["protection", 4]), { version: "1.21.1" });
    expect(survival.status).toBe("no-result");
    const creative = combineItems(fresh("sword"), book(["protection", 4]), {
      version: "1.21.1",
      creative: true,
    });
    expect(creative.status).toBe("ok");
    expect(creative.displayedCost).toBe(4);
  });

  it("repair by material on a book is an invalid pair", () => {
    expect(repairWithMaterials(fresh("book"), 1, { version: "1.21.1" }).status).toBe(
      "invalid-pair",
    );
  });

  it("every version in the data set can run a basic combine", () => {
    for (const v of ANVIL_VERSION_ORDER) {
      const outcome = combineItems(fresh("sword"), book(["unbreaking", 3]), { version: v });
      expect(outcome.status, v).toBe("ok");
      expect(outcome.displayedCost, v).toBe(3);
    }
  });
});

/* ------------------------------------------------------------------ */
/* run() surface                                                       */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("computes a combine from JSON input", () => {
    const out = run(
      JSON.stringify({
        target: { kind: "sword", enchants: [], priorWork: 0, damage: 0 },
        sacrifice: {
          kind: "book",
          enchants: [{ id: "sharpness", level: 5 }],
          priorWork: 0,
          damage: 0,
        },
      }),
      { version: "1.21.11" },
    );
    expect(out.Status).toBe("ok");
    expect(out["Level cost"]).toBe("5");
    expect(out.Result).toContain("sharpness 5");
  });

  it("computes a material repair", () => {
    const out = run(JSON.stringify({ target: { kind: "sword", damage: 700 }, materials: 1 }), {
      version: "1.16.5",
    });
    expect(out.Status).toBe("ok");
    expect(out["Level cost"]).toBe("1");
    expect(out["Materials used"]).toBe("1");
  });

  it("computes a rename", () => {
    const out = run(JSON.stringify({ target: { kind: "sword" }, rename: "set" }), {});
    expect(out.Status).toBe("ok");
    expect(out["Level cost"]).toBe("1");
  });

  it("throws on empty input", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    expect(() => run("  ", {})).toThrowError(ToolError);
  });

  it("throws on invalid JSON", () => {
    expect(() => run("{nope", {})).toThrowError(ToolError);
  });

  it("throws when target is missing", () => {
    expect(() => run("{}", {})).toThrowError(ToolError);
  });

  it("throws when neither sacrifice, materials, nor rename is given", () => {
    expect(() => run(JSON.stringify({ target: { kind: "sword" } }), {})).toThrowError(ToolError);
  });
});
