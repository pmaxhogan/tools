import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  applyDefenses,
  attackScalesWithDifficulty,
  buildArmor,
  damageAfterArmor,
  damageAfterEffects,
  enchantFitsWeapon,
  fallDamage,
  fallDistanceForDrop,
  hitsToKill,
  hitsToKillWithAbsorption,
  maceDamage,
  matchup,
  meleeDamage,
  mobStrike,
  playerStrike,
  round2,
  run,
  safeFallHeight,
  scaleWithDifficulty,
  smashBonus,
  weaponEnchantBonus,
} from "./index";
import { MOBS, mobInVersion, type Difficulty, type MobClassification, type VersionId } from "./data";

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

/* ------------------------------------------------------------------ */
/* Source-derived matchup vectors (mobs, difficulty, strikes,          */
/* absorption)                                                         */
/* ------------------------------------------------------------------ */

interface DerivedMatchupSections {
  mobStats: {
    mobs: {
      id: string;
      attack?: number;
      attackMin?: number;
      attackAvg?: number;
      attackMax?: number;
      hp: number;
      armor: number;
      classification: MobClassification;
      since?: string;
    }[];
  };
  difficultyCases: {
    cases: {
      mob: string;
      difficulty: Difficulty;
      dealt: number;
      version?: string;
      defender?: string;
      which?: string;
    }[];
  };
  strikeCases: {
    cases: {
      baseAttack: number;
      strength?: number;
      weakness?: number;
      critical?: boolean;
      enchant?: "sharpness" | "smite" | "bane";
      enchantLevel?: number;
      defenderClass?: MobClassification;
      dealt: number;
    }[];
  };
  absorptionCases: {
    cases: {
      dealt: number;
      armor?: number;
      toughness?: number;
      absorption: number;
      taken?: number;
      absorbed?: number;
      healthLost?: number;
      hp?: number;
      hits?: number;
    }[];
  };
}

describe("source-derived matchup vectors", () => {
  const derived = JSON.parse(
    readFileSync(`${VECTORS}damage-derived/source-derived.json`, "utf8"),
  ) as DerivedMatchupSections;

  it("MOBS in data.ts matches the committed mob stats exactly", () => {
    for (const v of derived.mobStats.mobs) {
      const mob = MOBS.find((m) => m.id === v.id);
      expect(mob, v.id).toBeDefined();
      expect(mob!.hp, v.id).toBe(v.hp);
      expect(mob!.armor, v.id).toBe(v.armor);
      expect(mob!.classification, v.id).toBe(v.classification);
      if (v.attackAvg !== undefined) {
        expect(mob!.attack.amount, v.id).toBe(v.attackAvg);
        expect(mob!.attack.min, v.id).toBe(v.attackMin);
        expect(mob!.attack.max, v.id).toBe(v.attackMax);
      } else {
        expect(mob!.attack.amount, v.id).toBe(v.attack);
      }
      expect(mob!.since, v.id).toBe(v.since as VersionId | undefined);
    }
    expect(derived.mobStats.mobs.length).toBe(MOBS.length);
  });

  it("reproduces every difficulty scaling case", () => {
    for (const c of derived.difficultyCases.cases) {
      const version = (c.version ?? "1.21.11") as VersionId;
      const strike = mobStrike(version, c.mob, c.difficulty, c.defender !== "mob");
      const got = c.which === "avg" || c.which === undefined ? strike.dealt : strike.dealt;
      expect(round2(got), JSON.stringify(c)).toBe(c.dealt);
    }
  });

  it("reproduces every strike case", () => {
    for (const c of derived.strikeCases.cases) {
      const r = playerStrike({
        version: "1.21.11",
        baseAttack: c.baseAttack,
        weaponFamily: "sword",
        strength: c.strength,
        weakness: c.weakness,
        critical: c.critical,
        enchant: c.enchant ?? "none",
        enchantLevel: c.enchantLevel ?? 0,
        defenderClass: c.defenderClass ?? "none",
      });
      expect(round2(r.dealt), JSON.stringify(c)).toBe(c.dealt);
    }
  });

  it("reproduces every absorption case", () => {
    for (const c of derived.absorptionCases.cases) {
      if (c.hits !== undefined) {
        expect(hitsToKillWithAbsorption(c.dealt, c.hp ?? 20, c.absorption)).toBe(c.hits);
        continue;
      }
      const r = applyDefenses(c.dealt, {
        armor: c.armor ?? 0,
        toughness: c.toughness ?? 0,
        absorption: c.absorption,
      });
      const label = JSON.stringify(c);
      expect(round2(r.taken), label).toBe(c.taken);
      expect(round2(r.absorbed), label).toBe(c.absorbed);
      expect(round2(r.healthLost), label).toBe(c.healthLost);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Matchup engine                                                      */
/* ------------------------------------------------------------------ */

describe("difficulty scaling rules", () => {
  it("mob melee and explosions scale in every version, arrows only from 1.20.6", () => {
    for (const v of ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"] as const) {
      expect(attackScalesWithDifficulty(v, "melee", true), v).toBe(true);
      expect(attackScalesWithDifficulty(v, "explosion", true), v).toBe(true);
      const legacy = v === "1.16.5" || v === "1.18.2";
      expect(attackScalesWithDifficulty(v, "arrow", true), v).toBe(!legacy);
    }
  });

  it("never scales against mob defenders", () => {
    for (const kind of ["melee", "arrow", "explosion"] as const) {
      expect(attackScalesWithDifficulty("1.21.11", kind, false)).toBe(false);
    }
  });

  it("uses the exact Player#hurtServer expressions", () => {
    expect(scaleWithDifficulty(3, "easy")).toBe(2.5);
    expect(scaleWithDifficulty(3, "hard")).toBe(4.5);
    expect(scaleWithDifficulty(1, "easy")).toBe(1); // min(d/2+1, d) keeps small hits
    expect(scaleWithDifficulty(30, "peaceful")).toBe(0);
  });
});

describe("weapon enchant gating", () => {
  it("Sharpness fits swords and axes only", () => {
    expect(enchantFitsWeapon("1.16.5", "sword", "sharpness")).toBe(true);
    expect(enchantFitsWeapon("1.16.5", "axe", "sharpness")).toBe(true);
    expect(enchantFitsWeapon("1.21.11", "mace", "sharpness")).toBe(false);
    expect(enchantFitsWeapon("1.21.11", "bow", "sharpness")).toBe(false);
  });

  it("Smite fits the mace from 1.21 on", () => {
    expect(enchantFitsWeapon("1.21.11", "mace", "smite")).toBe(true);
    expect(enchantFitsWeapon("1.20.6", "mace", "smite")).toBe(false);
  });

  it("bonus values match DamageEnchantment", () => {
    expect(weaponEnchantBonus("sharpness", 1, "none")).toBe(1);
    expect(weaponEnchantBonus("sharpness", 5, "none")).toBe(3);
    expect(weaponEnchantBonus("smite", 5, "undead")).toBe(12.5);
    expect(weaponEnchantBonus("smite", 5, "arthropod")).toBe(0);
    expect(weaponEnchantBonus("bane", 4, "arthropod")).toBe(10);
  });

  it("playerStrike rejects illegal enchant and weapon pairs", () => {
    expect(() =>
      playerStrike({
        version: "1.21.11",
        baseAttack: 6,
        weaponFamily: "bow",
        enchant: "sharpness",
        enchantLevel: 5,
      }),
    ).toThrowError(ToolError);
  });
});

describe("matchup", () => {
  it("zombie vs unarmored player on hard: 4.5 dealt, armor 0 taken in full", () => {
    const r = matchup({
      version: "1.21.11",
      difficulty: "hard",
      mode: "attack",
      attacker: { kind: "mob", mobId: "zombie" },
      defender: { kind: "player", kit: { build: {} } },
    });
    expect(round2(r.dealt)).toBe(4.5);
    expect(round2(r.taken)).toBe(4.5);
    expect(r.scaled).toBe(true);
    expect(r.hits).toBe(Math.ceil(20 / 4.5));
  });

  it("swap insight: zombie as defender never gets scaled damage and keeps its armor 2", () => {
    const r = matchup({
      version: "1.21.11",
      difficulty: "hard",
      mode: "attack",
      attacker: { kind: "mob", mobId: "warden" },
      defender: { kind: "mob", mobId: "zombie" },
    });
    // 30 raw (no scaling vs mobs), reduced by the zombie's 2 armor points.
    expect(round2(r.dealt)).toBe(30);
    expect(r.scaled).toBe(false);
    expect(round2(r.taken)).toBe(round2(damageAfterArmor(30, 2, 0)));
  });

  it("iron golem carries its swing range through the defenses", () => {
    const r = matchup({
      version: "1.21.11",
      difficulty: "normal",
      mode: "attack",
      attacker: { kind: "mob", mobId: "iron-golem" },
      defender: {
        kind: "player",
        kit: {
          build: {
            helmet: { material: "diamond", protection: 0 },
            chestplate: { material: "diamond", protection: 0 },
            leggings: { material: "diamond", protection: 0 },
            boots: { material: "diamond", protection: 0 },
          },
        },
      },
    });
    expect(r.takenMin).toBeLessThan(r.taken);
    expect(r.takenMax).toBeGreaterThan(r.taken);
    expect(round2(r.takenMin)).toBe(round2(damageAfterArmor(7.5, 20, 8)));
    expect(round2(r.takenMax)).toBe(round2(damageAfterArmor(21.5, 20, 8)));
  });

  it("player smite V crit vs zombie routes the strike through the armor formula", () => {
    const r = matchup({
      version: "1.21.11",
      difficulty: "normal",
      mode: "attack",
      attacker: {
        kind: "player",
        weaponDamage: 7,
        weaponFamily: "sword",
        critical: true,
        enchant: "smite",
        enchantLevel: 5,
      },
      defender: { kind: "mob", mobId: "zombie" },
    });
    expect(round2(r.dealt)).toBe(23); // 7 * 1.5 + 12.5
    expect(round2(r.taken)).toBe(round2(damageAfterArmor(23, 2, 0)));
  });

  it("fall mode stacks Feather Falling and Protection under the EPF cap", () => {
    const kit = {
      build: {
        helmet: { material: "netherite", protection: 4 },
        chestplate: { material: "netherite", protection: 4 },
        leggings: { material: "netherite", protection: 4 },
        boots: { material: "netherite", protection: 4 },
      },
      featherFalling: 4,
    };
    const r = matchup({
      version: "1.21.11",
      mode: "fall",
      fall: { height: 100 },
      defender: { kind: "player", kit },
    });
    // Base 97; EPF 12 + 16 = 28 caps at 20 (80% off); armor is bypassed.
    expect(round2(r.taken)).toBe(round2(damageAfterEffects(97, 0, 20)));
    const bare = matchup({
      version: "1.21.11",
      mode: "fall",
      fall: { height: 100 },
      defender: { kind: "player", kit: { build: {}, featherFalling: 4 } },
    });
    expect(round2(bare.taken)).toBe(
      round2(fallDamage({ version: "1.21.11", height: 100, featherFalling: 4 }).taken),
    );
  });

  it("mace crit multiplies the smash total before the enchant bonus (Player#attack order)", () => {
    const base = matchup({
      version: "1.21.11",
      mode: "mace",
      mace: { fallDistance: 10, density: 5 },
      defender: { kind: "player", kit: { build: {} } },
    });
    expect(round2(base.dealt)).toBe(55);
    const crit = matchup({
      version: "1.21.11",
      mode: "mace",
      mace: { fallDistance: 10, density: 5, critical: true, enchant: "smite", enchantLevel: 5 },
      defender: { kind: "mob", mobId: "zombie" },
    });
    expect(round2(crit.dealt)).toBe(55 * 1.5 + 12.5);
  });

  it("egapple absorption soaks before health and stretches hits to kill", () => {
    const r = matchup({
      version: "1.21.11",
      difficulty: "normal",
      mode: "attack",
      attacker: { kind: "mob", mobId: "ravager" },
      defender: { kind: "player", kit: { build: {}, absorption: 16, resistance: 1 } },
    });
    // 12 dealt, resistance 1 leaves 9.6, all soaked by the 16 absorption.
    expect(round2(r.taken)).toBe(9.6);
    expect(round2(r.absorbed)).toBe(9.6);
    expect(round2(r.healthLost)).toBe(0);
    expect(r.hits).toBe(Math.ceil((20 + 16) / 9.6));
  });

  it("rejects the warden before 1.20.6 and stale mob ids", () => {
    expect(() =>
      matchup({
        version: "1.16.5",
        mode: "attack",
        attacker: { kind: "mob", mobId: "warden" },
        defender: { kind: "player", kit: { build: {} } },
      }),
    ).toThrowError(/does not exist in 1.16.5/);
    expect(() =>
      matchup({
        version: "1.21.11",
        mode: "attack",
        attacker: { kind: "mob", mobId: "herobrine" },
        defender: { kind: "player", kit: { build: {} } },
      }),
    ).toThrowError(ToolError);
  });

  it("mobInVersion gates the warden list entry", () => {
    const warden = MOBS.find((m) => m.id === "warden")!;
    expect(mobInVersion(warden, "1.18.2")).toBe(false);
    expect(mobInVersion(warden, "1.20.6")).toBe(true);
  });
});
