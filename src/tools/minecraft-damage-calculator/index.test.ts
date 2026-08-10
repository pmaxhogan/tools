import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  buildArmor,
  damageAfterArmor,
  damageAfterEffects,
  fallDamage,
  fallDistanceForDrop,
  hitsToKill,
  maceDamage,
  meleeDamage,
  round2,
  run,
  safeFallHeight,
  smashBonus,
} from "./index";
import type { VersionId } from "./data";

/* ------------------------------------------------------------------ */
/* Golden vectors: measured on real dedicated servers over RCON        */
/* ------------------------------------------------------------------ */

const VECTORS = fileURLToPath(new URL("../../../mc-pipeline/vectors/", import.meta.url));

function loadVectors(family: "damage" | "fall", version: string) {
  return JSON.parse(readFileSync(`${VECTORS}${family}/${version}.json`, "utf8")) as {
    samples: Record<string, unknown>[];
  };
}

/** Damage types tagged bypasses_armor in every covered version. */
const BYPASSES_ARMOR = new Set(["magic", "out_of_world", "generic"]);

interface DamageSample {
  armor: number | null;
  toughness: number | null;
  amount: number;
  type: string;
  taken: number;
  resistance?: number;
  equipped?: { material: string; pieces: number; protection: number };
}

/**
 * The recorded armor / toughness fields are the mob's actual attribute
 * totals as read back by the harness (`attribute ... get`), so every sample
 * decodes uniformly: armor formula on those totals, then Resistance, then
 * the equipped pieces' Protection EPF (pieces x level, x1 vs melee).
 */
function expectedDamage(s: DamageSample): number {
  const armor = s.armor ?? 0;
  const toughness = s.toughness ?? 0;
  let a = BYPASSES_ARMOR.has(s.type) ? s.amount : damageAfterArmor(s.amount, armor, toughness);
  if (s.resistance) a = damageAfterEffects(a, s.resistance, 0);
  if (s.equipped) a = damageAfterEffects(a, 0, s.equipped.pieces * s.equipped.protection);
  return a;
}

describe("golden damage vectors (rcon-e2e)", () => {
  for (const version of ["1.20.6", "1.21.1", "1.21.11", "26.2"]) {
    it(`reproduces every ${version} sample exactly`, () => {
      const { samples } = loadVectors("damage", version);
      expect(samples.length).toBeGreaterThan(300);
      for (const raw of samples) {
        const s = raw as unknown as DamageSample;
        expect(round2(expectedDamage(s)), JSON.stringify(s)).toBe(s.taken);
      }
    });
  }
});

interface FallSample {
  height: number;
  featherFalling: number;
  slowFalling: boolean;
  taken: number;
}

describe("golden fall vectors (rcon-e2e)", () => {
  for (const version of ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"]) {
    it(`reproduces every ${version} sample exactly`, () => {
      const { samples } = loadVectors("fall", version);
      expect(samples.length).toBe(14);
      for (const raw of samples) {
        const s = raw as unknown as FallSample;
        const model = fallDamage({
          version: version as VersionId,
          height: s.height,
          featherFalling: s.featherFalling,
          slowFalling: s.slowFalling,
        }).taken;
        expect(round2(model), `${version} ${JSON.stringify(s)}`).toBe(s.taken);
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* Source-derived vectors (pre-/damage eras)                           */
/* ------------------------------------------------------------------ */

describe("source-derived vectors (1.16.5 / 1.18.2)", () => {
  const derived = JSON.parse(
    readFileSync(`${VECTORS}damage-derived/source-derived.json`, "utf8"),
  ) as {
    armorSamples: { armor: number; toughness: number; amount: number; taken: number }[];
    protectionSamples: {
      armor: number;
      toughness: number;
      amount: number;
      protectionLevels: number;
      taken: number;
    }[];
    resistanceSamples: { resistance: number; amount: number; taken: number }[];
  };

  it("has at least 15 armor cases", () => {
    expect(derived.armorSamples.length).toBeGreaterThanOrEqual(15);
  });

  it("reproduces every armor case", () => {
    for (const s of derived.armorSamples) {
      expect(round2(damageAfterArmor(s.amount, s.armor, s.toughness)), JSON.stringify(s)).toBe(
        s.taken,
      );
    }
  });

  it("reproduces every protection case, including the EPF cap", () => {
    for (const s of derived.protectionSamples) {
      const model = damageAfterEffects(
        damageAfterArmor(s.amount, s.armor, s.toughness),
        0,
        s.protectionLevels,
      );
      expect(round2(model), JSON.stringify(s)).toBe(s.taken);
    }
  });

  it("reproduces every resistance case", () => {
    for (const s of derived.resistanceSamples) {
      expect(round2(damageAfterEffects(s.amount, s.resistance, 0))).toBe(s.taken);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Formula unit checks                                                 */
/* ------------------------------------------------------------------ */

describe("armor formula", () => {
  it("passes damage through at armor 0", () => {
    expect(damageAfterArmor(10, 0, 0)).toBe(10);
    expect(damageAfterArmor(10, 0, 20)).toBe(10);
  });

  it("caps at 80% (20 effective points)", () => {
    // armor 30, small hit: clamp(...) hits the 20 point cap.
    expect(damageAfterArmor(10, 30, 0)).toBeCloseTo(2, 5);
    expect(damageAfterArmor(1, 30, 1000)).toBeCloseTo(0.2, 5);
  });

  it("survives toughness overflow without NaN", () => {
    const d = damageAfterArmor(10, 20, 1e30);
    expect(Number.isFinite(d)).toBe(true);
    // Infinite toughness means the pierce term vanishes: full 20 points.
    expect(d).toBeCloseTo(2, 5);
  });

  it("matches the measured 1.21.11 pierce case (armor 25, toughness 20, 100 damage)", () => {
    expect(round2(damageAfterArmor(100, 25, 20))).toBe(57.14);
  });

  it("Breach subtracts 15% armor effectiveness per level", () => {
    // armor 20 vs 10: effective points 15, fraction 0.6; Breach 2 removes 0.3.
    expect(round2(damageAfterArmor(10, 20, 0, 2))).toBe(7);
    // Breach 4 removes 0.6: the fraction floors at 0, never negative.
    expect(damageAfterArmor(10, 20, 0, 4)).toBe(10);
    expect(damageAfterArmor(10, 5, 0, 4)).toBe(10);
  });
});

describe("effects (resistance + EPF)", () => {
  it("resistance 5 is full immunity", () => {
    expect(damageAfterEffects(100, 5, 0)).toBe(0);
  });

  it("resistance scales 20% per level", () => {
    expect(round2(damageAfterEffects(10, 1, 0))).toBe(8);
    expect(round2(damageAfterEffects(10, 4, 0))).toBe(2);
  });

  it("EPF clamps to 20", () => {
    expect(round2(damageAfterEffects(10, 0, 20))).toBe(2);
    expect(round2(damageAfterEffects(10, 0, 28))).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Fall model                                                          */
/* ------------------------------------------------------------------ */

describe("fall model", () => {
  it("legacy fall distance loses the landing tick (100 block drop reads ~97.52)", () => {
    expect(round2(fallDistanceForDrop("1.16.5", 100))).toBe(97.52);
    expect(fallDistanceForDrop("1.21.11", 100)).toBe(100);
  });

  it("legacy and modern disagree on the measured boundary drops", () => {
    expect(fallDamage({ version: "1.18.2", height: 23.5 }).taken).toBe(21);
    expect(fallDamage({ version: "1.21.11", height: 23.5 }).taken).toBe(20);
    expect(fallDamage({ version: "1.16.5", height: 50 }).taken).toBe(46);
    expect(fallDamage({ version: "26.2", height: 50 }).taken).toBe(47);
  });

  it("matches the re-measured 1.16.5 3.25 / 3.5 / 3.75 boundary", () => {
    // Live-server probe, 2026-08-10: 3.25 -> 0, 3.5 -> 1, 3.75 -> 1.
    expect(fallDamage({ version: "1.16.5", height: 3.25 }).taken).toBe(0);
    expect(fallDamage({ version: "1.16.5", height: 3.5 }).taken).toBe(1);
    expect(fallDamage({ version: "1.16.5", height: 3.75 }).taken).toBe(1);
  });

  it("slow falling always lands soft", () => {
    for (const v of ["1.16.5", "1.21.11"] as const) {
      expect(fallDamage({ version: v, height: 100, slowFalling: true }).taken).toBe(0);
    }
  });

  it("jump boost raises the safe threshold", () => {
    expect(fallDamage({ version: "1.21.11", height: 5, jumpBoost: 2 }).taken).toBe(0);
  });

  it("safe height is at least 3 blocks everywhere", () => {
    for (const v of ["1.16.5", "1.21.11"] as const) {
      expect(safeFallHeight(v)).toBeGreaterThanOrEqual(3);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Mace                                                                */
/* ------------------------------------------------------------------ */

describe("mace smash", () => {
  it("follows the three-segment bonus curve", () => {
    expect(smashBonus(1.5)).toBe(0); // threshold is exclusive
    expect(smashBonus(2)).toBe(8);
    expect(smashBonus(3)).toBe(12);
    expect(smashBonus(8)).toBe(22);
    expect(smashBonus(10)).toBe(24);
    expect(smashBonus(50)).toBe(64);
  });

  it("adds density and base damage, then runs target reductions", () => {
    const r = maceDamage({ version: "1.21.11", fallDistance: 10, density: 5, armor: 0, toughness: 0 });
    // 6 base + 24 smash + 0.5*5*10 density = 55.
    expect(r.dealt).toBe(55);
    expect(round2(r.taken)).toBe(55);
  });

  it("no smash below the 1.5 block threshold", () => {
    const r = maceDamage({ version: "1.21.1", fallDistance: 1, density: 5 });
    expect(r.isSmash).toBe(false);
    expect(r.dealt).toBe(6);
  });

  it("Breach makes the mace pierce full netherite", () => {
    const plain = maceDamage({ version: "1.21.11", fallDistance: 8, armor: 20, toughness: 12 });
    const breach = maceDamage({
      version: "1.21.11",
      fallDistance: 8,
      armor: 20,
      toughness: 12,
      breach: 4,
    });
    expect(breach.taken).toBeGreaterThan(plain.taken);
  });

  it("refuses versions before the mace existed", () => {
    expect(() => maceDamage({ version: "1.20.6", fallDistance: 5 })).toThrowError(ToolError);
    try {
      maceDamage({ version: "1.16.5", fallDistance: 5 });
    } catch (e) {
      expect((e as ToolError).code).toBe("mace-not-in-version");
      expect((e as ToolError).fix).toMatch(/1\.21/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Armor builds                                                        */
/* ------------------------------------------------------------------ */

describe("buildArmor", () => {
  it("full netherite is 20 armor, 12 toughness", () => {
    const b = buildArmor("1.21.11", {
      helmet: { material: "netherite", protection: 4 },
      chestplate: { material: "netherite", protection: 4 },
      leggings: { material: "netherite", protection: 4 },
      boots: { material: "netherite", protection: 4 },
    });
    expect(b).toEqual({ armor: 20, toughness: 12, protectionLevels: 16 });
  });

  it("rejects copper before 1.21.9", () => {
    expect(() =>
      buildArmor("1.20.6", { helmet: { material: "copper", protection: 0 } }),
    ).toThrowError(ToolError);
  });

  it("rejects turtle shell outside the helmet slot", () => {
    expect(() =>
      buildArmor("1.21.11", { boots: { material: "turtle", protection: 0 } }),
    ).toThrowError(/no boots item/);
  });
});

/* ------------------------------------------------------------------ */
/* run() surface and input validation                                  */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("melee mode returns the labeled record", () => {
    const out = run("", { mode: "melee", version: "1.21.11", amount: 7, armor: 20, toughness: 8 });
    expect(out["Damage dealt"]).toBe("7");
    expect(out["Damage taken"]).toContain("hearts");
    expect(out["Hits to kill"]).toContain("20 HP");
  });

  it("critical hits multiply by 1.5", () => {
    const out = run("", {
      mode: "melee",
      version: "1.21.11",
      amount: 8,
      armor: 0,
      toughness: 0,
      critical: true,
    });
    expect(out["Damage dealt"]).toBe("12");
  });

  it("fall mode reports distance, damage and safe height", () => {
    const out = run("", { mode: "fall", version: "1.16.5", height: 100 });
    expect(out["Fall distance"]).toBe("97.52 blocks");
    expect(out["Base damage"]).toBe("95");
  });

  it("mace mode reports the breakdown", () => {
    const out = run("", { mode: "mace", version: "26.2", maceFall: 10, density: 5 });
    expect(out["Damage dealt"]).toContain("55");
  });

  it("rejects unknown modes and versions with actionable errors", () => {
    expect(() => run("", { mode: "laser" })).toThrowError(ToolError);
    expect(() => run("", { mode: "melee", version: "1.8.9" })).toThrowError(/not a supported/);
  });

  it("rejects NaN and negative inputs with a fix hint", () => {
    expect(() =>
      run("", { mode: "melee", version: "1.21.11", amount: Number.NaN }),
    ).toThrowError(ToolError);
    try {
      run("", { mode: "fall", version: "1.21.11", height: -5 });
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).fix).toMatch(/between/);
    }
    expect(() => meleeDamage({ version: "1.21.11", amount: 10, armor: -1, toughness: 0 })).toThrowError(
      /between 0 and/,
    );
  });
});

describe("hitsToKill", () => {
  it("rounds up and handles zero damage", () => {
    expect(hitsToKill(7, 20)).toBe(3);
    expect(hitsToKill(20, 20)).toBe(1);
    expect(hitsToKill(0, 20)).toBe(Infinity);
  });
});
