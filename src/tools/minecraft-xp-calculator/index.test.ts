import { describe, expect, it } from "vitest";
import {
  damagePerHit,
  hitsToKill,
  levelFromTotalXp,
  MAX_LEVEL,
  mendingXpForDurability,
  normalizeMixture,
  planMixture,
  run,
  sustainability,
  totalXpAtLevel,
  xpToNextLevel,
  type McXpOpts,
  type MixtureEntry,
  type SustainInput,
} from "./index";
import {
  MATERIAL_BY_ID,
  MIXTURE_PRESET_BY_ID,
  presetWeights,
  TOOL_FAMILY_BY_ID,
  XP_SOURCE_BY_ID,
} from "./data";
import { ToolError } from "../types";
import vectors from "../../../mc-pipeline/vectors/xp/source-derived.json";

/** The union of every vector case shape (fields optional per type). */
interface VectorCase {
  type: string;
  provenance: string;
  level?: number;
  expected?: number;
  from?: number;
  to?: number;
  totalXp?: number;
  expectedLevel?: number;
  expectedInto?: number;
  expectedNext?: number;
  durability?: number;
  expectedXp?: number;
  source?: string;
  min?: number;
  max?: number;
  mean?: number;
  expectedAverage?: number;
  expectedGuaranteed?: number | null;
  input?: SustainInput;
  family?: string;
  material?: string;
  sharpness?: number;
  smite?: number;
  bane?: number;
  fireAspectFreeHp?: number;
  mixture?: MixtureEntry[];
  expectedAvg?: number;
  expectedWorstSource?: string;
}

const vectorCases = vectors.cases as unknown as VectorCase[];

interface SustainExpected {
  avgSelfSustaining: boolean;
  avgActions: number | null;
  worstSelfSustaining: boolean;
  worstActions: number | null;
  worstSource: string;
}

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
    expect(vectorCases.length).toBeGreaterThanOrEqual(30);
    expect(vectorCases.filter((c) => c.type === "sustain" || c.type === "hits").length).toBeGreaterThanOrEqual(15);

    for (const c of vectorCases) {
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
          case "sustain": {
            const out = sustainability(c.input!);
            const exp = c.expected as unknown as SustainExpected;
            expect(out.avgSelfSustaining).toBe(exp.avgSelfSustaining);
            expect(out.avgActions).toBe(exp.avgActions);
            expect(out.worstSelfSustaining).toBe(exp.worstSelfSustaining);
            expect(out.worstActions).toBe(exp.worstActions);
            expect(out.worstSource.id).toBe(exp.worstSource);
            break;
          }
          case "hits": {
            const family = TOOL_FAMILY_BY_ID.get(c.family!)!;
            const material = MATERIAL_BY_ID.get(c.material!)!;
            const source = XP_SOURCE_BY_ID.get(c.source!)!;
            const dmg = damagePerHit(family, material, source, c.sharpness!, c.smite!, c.bane!);
            expect(hitsToKill(source.hp!, dmg, c.fireAspectFreeHp!)).toBe(c.expected);
            break;
          }
          case "mixture-plan": {
            const delta = totalXpAtLevel(c.to!) - totalXpAtLevel(c.from!);
            const plan = planMixture(delta, c.mixture!);
            expect(plan.avgActions).toBe(c.expectedAvg);
            expect(plan.guaranteedActions).toBe(c.expectedGuaranteed ?? null);
            expect(plan.worstSource.id).toBe(c.expectedWorstSource);
            break;
          }
          default:
            throw new Error(`Unhandled vector case type: ${String(c.type)}`);
        }
      });
    }
  });

  describe("mixtures", () => {
    it("normalizes an equal split to equal shares", () => {
      const shares = normalizeMixture([
        { sourceId: "zombie", weight: 1 },
        { sourceId: "blaze", weight: 1 },
      ]);
      expect(shares.map((s) => s.share)).toEqual([0.5, 0.5]);
    });

    it("normalizes skewed weights and any scale identically", () => {
      const a = planMixture(1395, [
        { sourceId: "zombie", weight: 3 },
        { sourceId: "blaze", weight: 1 },
      ]);
      const b = planMixture(1395, [
        { sourceId: "zombie", weight: 75 },
        { sourceId: "blaze", weight: 25 },
      ]);
      expect(a.avgActions).toBe(b.avgActions);
      expect(a.meanXpPerAction).toBeCloseTo(6.25, 10);
    });

    it("defines the worst case as the single worst source at 100 percent", () => {
      const plan = planMixture(1395, [
        { sourceId: "diamond_ore", weight: 99 },
        { sourceId: "coal_ore", weight: 1 },
      ]);
      // Even at 1 percent weight, coal ore (min 0) is the worst source.
      expect(plan.worstSource.id).toBe("coal_ore");
      expect(plan.guaranteedActions).toBeNull();
    });

    it("loads authoritative preset weights per version from the committed data", () => {
      const overworld = MIXTURE_PRESET_BY_ID.get("overworld_mobs")!;
      expect(presetWeights(overworld, "1.16.5")).toMatchObject({ zombie: 95, spider: 100 });
      expect(presetWeights(overworld, "1.21.11")).toMatchObject({ zombie: 90 });
      expect(presetWeights(overworld, "26.2")).toMatchObject({ zombie: 90 });
      const mining = MIXTURE_PRESET_BY_ID.get("mining_y0")!;
      expect(presetWeights(mining, "1.16.5")).toBeNull();
      expect(presetWeights(mining, "1.18.2")).toMatchObject({ lapis_ore: 0.6413 });
      const nether = MIXTURE_PRESET_BY_ID.get("nether_mobs")!;
      const weights = presetWeights(nether, "1.20.6")!;
      // Preset weights must resolve to known sources of one kind.
      const shares = normalizeMixture(
        Object.entries(weights).map(([sourceId, weight]) => ({ sourceId, weight })),
      );
      expect(shares.every((s) => s.source.kind === "mob")).toBe(true);
    });

    it("rejects an empty mixture, mixed kinds, and zero weights", () => {
      expect(() => normalizeMixture([])).toThrowError(ToolError);
      try {
        normalizeMixture([]);
      } catch (e) {
        expect((e as ToolError).code).toBe("empty-mixture");
      }
      try {
        normalizeMixture([
          { sourceId: "zombie", weight: 1 },
          { sourceId: "coal_ore", weight: 1 },
        ]);
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("mixed-kinds");
      }
      try {
        normalizeMixture([{ sourceId: "zombie", weight: 0 }]);
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("zero-weights");
      }
      try {
        normalizeMixture([{ sourceId: "zombie", weight: -1 }]);
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("bad-weight");
      }
    });
  });

  describe("sustainability model", () => {
    const base: SustainInput = {
      family: "sword",
      material: "diamond",
      durability: 1561,
      mending: true,
      unbreaking: 0,
      sharpness: 0,
      smite: 0,
      bane: 0,
      fireAspect: 0,
      fireAspectFreeHp: 3,
      mixture: [{ sourceId: "zombie", weight: 1 }],
    };

    it("ignores the free HP setting while Fire Aspect is level 0", () => {
      const off = sustainability({ ...base, mending: false, fireAspect: 0, fireAspectFreeHp: 50 });
      expect(off.perSource[0]!.hits).toBe(3);
      const on = sustainability({ ...base, mending: false, fireAspect: 1, fireAspectFreeHp: 50 });
      expect(on.perSource[0]!.hits).toBe(1);
    });

    it("scales expected durability loss by 1/(unbreaking + 1)", () => {
      for (const level of [0, 1, 2, 3]) {
        const out = sustainability({ ...base, mending: false, unbreaking: level });
        expect(out.avgLossPerAction).toBeCloseTo(3 / (level + 1), 10);
      }
    });

    it("rejects both Smite and Bane at once (mutually exclusive group)", () => {
      try {
        sustainability({ ...base, smite: 5, bane: 5 });
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("exclusive-damage-enchants");
        expect((e as ToolError).fix).toMatch(/at most one/);
      }
    });

    it("rejects combat enchantments on a pickaxe and Fire Aspect on an axe", () => {
      try {
        sustainability({
          ...base,
          family: "pickaxe",
          sharpness: 5,
          mixture: [{ sourceId: "coal_ore", weight: 1 }],
        });
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("enchant-not-applicable");
      }
      try {
        sustainability({ ...base, family: "axe", fireAspect: 1 });
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("enchant-not-applicable");
        expect((e as ToolError).fix).toMatch(/sword/);
      }
    });

    it("rejects a source kind that does not match the tool family", () => {
      try {
        sustainability({ ...base, mixture: [{ sourceId: "diamond_ore", weight: 1 }] });
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("kind-mismatch");
        expect((e as ToolError).fix).toMatch(/mobs/);
      }
    });

    it("rejects unknown family, unknown material, and out-of-range durability", () => {
      try {
        sustainability({ ...base, family: "hoe" });
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("unknown-family");
      }
      try {
        sustainability({ ...base, material: "emerald" });
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("unknown-material");
      }
      try {
        sustainability({ ...base, durability: 2000 });
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("bad-durability");
        expect((e as ToolError).fix).toMatch(/1561/);
      }
      try {
        sustainability({ ...base, unbreaking: 4 });
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("bad-enchant-level");
      }
    });
  });
});
