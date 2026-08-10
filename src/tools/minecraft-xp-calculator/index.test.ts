import { describe, expect, it } from "vitest";
import {
  levelFromTotalXp,
  MAX_LEVEL,
  mendingXpForDurability,
  run,
  totalXpAtLevel,
  xpToNextLevel,
  type McXpOpts,
} from "./index";
import { XP_SOURCE_BY_ID } from "./data";
import { ToolError } from "../types";
import vectors from "../../../mc-pipeline/vectors/xp/source-derived.json";

function opts(overrides: Partial<McXpOpts>): McXpOpts {
  return {
    mode: "levels",
    fromLevel: 0,
    toLevel: 30,
    totalXp: 1395,
    durability: 1561,
    source: "zombie",
    ...overrides,
  };
}

describe("minecraft-xp-calculator", () => {
  it("computes the level 0 to 30 climb with zombie kills (happy path)", () => {
    const out = run(undefined, opts({}));
    expect(out["Total XP at level 0"]).toBe("0 points");
    expect(out["Total XP at level 30"]).toBe("1,395 points");
    expect(out["XP needed (0 to 30)"]).toBe("1,395 points");
    expect(out["Next level up from 0"]).toBe("7 points");
    expect(out["XP per kill (Zombie)"]).toBe("5 XP per kill");
    expect(out["Needed on average"]).toBe("279 kills");
    expect(out["Guaranteed"]).toBe("279 kills (drop amount is fixed)");
  });

  it("converts total XP back to a level with progress (xp mode)", () => {
    const out = run(undefined, opts({ mode: "xp", totalXp: 1394 }));
    expect(out.Level).toBe("29");
    expect(out["Progress into level"]).toBe("106 of 107 points (99%)");
    expect(out["XP to reach level 30"]).toBe("1 points");
  });

  it("prices a full diamond-tool Mending repair in bottles (mending mode)", () => {
    const out = run(undefined, opts({ mode: "mending", durability: 1561, source: "xp_bottle" }));
    expect(out["Orb XP needed"]).toBe("781 points (each point repairs 2 durability)");
    // Total XP at level 23 is 751 (mid tier closed form), so 781 points is 30 past it.
    expect(out["Same XP as climbing"]).toBe("level 0 to 23, plus 30 points");
    expect(out["XP per bottle (Bottle o' Enchanting)"]).toBe("3 to 11 XP, 7 on average per bottle");
    expect(out["Needed on average"]).toBe("112 bottles");
    expect(out["Guaranteed (worst case)"]).toBe("261 bottles");
  });

  it("handles level 0 to 0: zero XP, zero kills (edge case)", () => {
    const out = run(undefined, opts({ toLevel: 0 }));
    expect(out["XP needed (0 to 0)"]).toBe("0 points");
    expect(out["Needed on average"]).toBe("0 kills");
  });

  it("handles huge levels exactly (edge case)", () => {
    // Summation ground truth for the closed form at the input cap.
    let sum = 0;
    for (let level = 0; level < MAX_LEVEL; level++) sum += xpToNextLevel(level);
    expect(totalXpAtLevel(MAX_LEVEL)).toBe(sum);
    expect(Number.isSafeInteger(sum)).toBe(true);
    const out = run(undefined, opts({ toLevel: MAX_LEVEL, source: "ender_dragon_first" }));
    expect(out[`XP needed (0 to ${MAX_LEVEL.toLocaleString("en-US")})`]).toBe(
      `${sum.toLocaleString("en-US")} points`,
    );
  });

  it("accepts string option values as restored from the URL fragment", () => {
    const out = run(
      undefined,
      opts({ fromLevel: "27" as unknown as number, toLevel: "30" as unknown as number, source: "blaze" }),
    );
    expect(out["XP needed (27 to 30)"]).toBe("306 points");
    expect(out["Needed on average"]).toBe("31 kills");
  });

  it("reports no worst-case bound for sources that can drop 0 XP", () => {
    const out = run(undefined, opts({ source: "coal_ore" }));
    expect(out["Needed on average"]).toBe("1,395 blocks mined");
    expect(out["Guaranteed (worst case)"]).toMatch(/minimum drop is 0/);
  });

  describe("ToolError branches", () => {
    it("rejects reversed levels with a swap hint", () => {
      try {
        run(undefined, opts({ fromLevel: 31, toLevel: 30 }));
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe("levels-reversed");
        expect((e as ToolError).fix).toMatch(/Swap/);
      }
    });

    it("rejects non-integer input with a fix hint", () => {
      try {
        run(undefined, opts({ fromLevel: 1.5 }));
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("not-an-integer");
        expect((e as ToolError).fix).toMatch(/integer/);
      }
    });

    it("rejects out-of-range values (negative and over the cap)", () => {
      expect(() => run(undefined, opts({ mode: "xp", totalXp: -1 }))).toThrowError(ToolError);
      try {
        run(undefined, opts({ toLevel: MAX_LEVEL + 1 }));
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("out-of-range");
        expect((e as ToolError).fix).toMatch(/Pick a value/);
      }
    });

    it("rejects an unknown XP source", () => {
      try {
        run(undefined, opts({ source: "chicken jockey" }));
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("unknown-source");
        expect((e as ToolError).fix).toMatch(/dropdown/);
      }
    });

    it("rejects an unknown mode", () => {
      try {
        run(undefined, opts({ mode: "speedrun" }));
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("unknown-mode");
        expect((e as ToolError).fix).toMatch(/mode/i);
      }
    });
  });

  describe("closed forms vs per-level summation of the source curve", () => {
    it("matches direct summation of Player#getXpNeededForNextLevel for levels 0..10000", () => {
      let sum = 0;
      for (let level = 0; level <= 10000; level++) {
        expect(totalXpAtLevel(level)).toBe(sum);
        sum += xpToNextLevel(level);
      }
    });

    it("inverts exactly at and around every boundary for levels 0..600", () => {
      for (let level = 0; level <= 600; level++) {
        const total = totalXpAtLevel(level);
        expect(levelFromTotalXp(total)).toBe(level);
        if (total > 0) expect(levelFromTotalXp(total - 1)).toBe(level - 1);
        expect(levelFromTotalXp(total + xpToNextLevel(level) - 1)).toBe(level);
      }
    });
  });

  describe("source-derived vectors (mc-pipeline/vectors/xp)", () => {
    expect(vectors.method).toBe("source-derived");
    expect(vectors.cases.length).toBeGreaterThanOrEqual(30);

    for (const c of vectors.cases) {
      it(`${c.type}: ${c.provenance.slice(0, 60)}`, () => {
        switch (c.type) {
          case "xp-to-next":
            expect(xpToNextLevel(c.level!)).toBe(c.expected);
            break;
          case "total-xp":
            expect(totalXpAtLevel(c.level!)).toBe(c.expected);
            break;
          case "delta":
            expect(totalXpAtLevel(c.to!) - totalXpAtLevel(c.from!)).toBe(c.expected);
            break;
          case "xp-to-level": {
            const level = levelFromTotalXp(c.totalXp!);
            expect(level).toBe(c.expectedLevel);
            expect(c.totalXp! - totalXpAtLevel(level)).toBe(c.expectedInto);
            expect(xpToNextLevel(level)).toBe(c.expectedNext);
            break;
          }
          case "mending":
            expect(mendingXpForDurability(c.durability!)).toBe(c.expectedXp);
            break;
          case "source": {
            const src = XP_SOURCE_BY_ID.get(c.source!)!;
            expect(src).toBeDefined();
            expect(src.min).toBe(c.min);
            expect(src.max).toBe(c.max);
            expect(src.mean).toBe(c.mean);
            break;
          }
          case "kills": {
            const src = XP_SOURCE_BY_ID.get(c.source!)!;
            const delta = totalXpAtLevel(c.to!) - totalXpAtLevel(c.from!);
            expect(Math.ceil(delta / src.mean)).toBe(c.expectedAverage);
            if (c.expectedGuaranteed === null) {
              expect(src.min).toBe(0);
            } else {
              expect(Math.ceil(delta / src.min)).toBe(c.expectedGuaranteed);
            }
            break;
          }
          default:
            throw new Error(`Unhandled vector case type: ${String(c.type)}`);
        }
      });
    }
  });
});
