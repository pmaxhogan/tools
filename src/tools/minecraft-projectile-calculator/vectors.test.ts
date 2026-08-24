import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { simulate } from "./index";
import { PROJECTILE_BY_ID, VERSIONS, type ProjectileId, type VersionId } from "./data";

/**
 * Golden vectors from mc-pipeline, one file per covered version.
 *
 * Two shapes, both authoritative:
 *
 * - `measured: true` (`method: "rcon-e2e"`): the harness summoned each entity
 *   on a real dedicated server with an explicit Motion, froze the tick loop,
 *   stepped one tick at a time, and read Pos and Motion back verbatim. These
 *   are exact doubles, so every assertion is strict equality. A simulator that
 *   is merely close is wrong.
 * - `measured: false` (`method: "source-derived"`): the version predates the
 *   tick freeze and tick step commands, so per tick positions cannot be
 *   measured. The harness instead recorded the gravity and drag constants it
 *   read out of the decompiled source, resolved through the projectile's class
 *   chain most derived first, with the defining class stored beside each value.
 *   Those are asserted exactly against data.ts.
 */

const VECTOR_DIR = join(process.cwd(), "mc-pipeline", "vectors", "projectile");

interface Series {
  tick: number;
  pos: [number, number, number];
  motion: [number, number, number];
}

interface VectorCase {
  type: string;
  entity: string;
  summonNbt: string | null;
  launch: "flat-fast" | "angled";
  origin: [number, number, number];
  motion: [number, number, number];
  /** The entity fields the harness read back right after the summon. */
  initialFields: Record<string, unknown>;
  expiredAtTick: number | null;
  series: Series[];
}

/** Every leaf constant carries the class it was defined on. */
interface ConstantLeaf {
  value: number;
  class: string;
  note: string | null;
}

interface SourceConstant {
  type: string;
  /** Most derived class first, so a subclass override is never shadowed. */
  classChain: string[];
  constants: Partial<{
    drag: ConstantLeaf;
    gravity: ConstantLeaf;
    waterDrag: ConstantLeaf;
    speedMultiplier: ConstantLeaf;
  }>;
  modernReference: { fromVersion: string; drag: number; gravity: number } | null;
  matchesModern: boolean | null;
}

interface VectorFile {
  version: string;
  method: "rcon-e2e" | "source-derived";
  measured: boolean;
  note: string;
  ticksPerCase?: number;
  unavailable?: string[];
  cases?: VectorCase[];
  sourceConstants?: SourceConstant[];
}

/**
 * A vector entity type maps onto a projectile id. A summoned firework rocket is
 * not flagged shot at angle, so it maps to the free flying rocket rather than
 * the crossbow one.
 */
const TYPE_TO_PROJECTILE: Record<string, ProjectileId> = {
  arrow: "arrow",
  tipped_arrow: "tipped_arrow",
  spectral_arrow: "spectral_arrow",
  trident: "trident",
  snowball: "snowball",
  egg: "egg",
  ender_pearl: "ender_pearl",
  splash_potion: "splash_potion",
  lingering_potion: "lingering_potion",
  experience_bottle: "experience_bottle",
  firework_rocket: "firework_rocket_free",
  fireball: "fireball",
  small_fireball: "small_fireball",
};

function listVectorFiles(): { version: VersionId; file: VectorFile }[] {
  let names: string[];
  try {
    names = readdirSync(VECTOR_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: { version: VersionId; file: VectorFile }[] = [];
  for (const name of names.sort()) {
    const version = name.replace(/\.json$/, "");
    if (!(VERSIONS as string[]).includes(version)) continue;
    // The pipeline owns this directory, so a half written file must not take
    // the whole suite down at collection time.
    let file: VectorFile;
    try {
      file = JSON.parse(readFileSync(join(VECTOR_DIR, name), "utf8")) as VectorFile;
    } catch {
      continue;
    }
    out.push({ version: version as VersionId, file });
  }
  return out;
}

/**
 * The acceleration a summoned hurting projectile actually carries, read from
 * the fields the harness captured rather than assumed.
 *
 * Through 1.20.6 the acceleration is a stored Power vector, which a plain
 * /summon leaves at zero, so the entity coasts on drag alone. From 1.21.1 it is
 * the acceleration_power field, which defaults to 0.1 and is applied along the
 * normalized motion, so a summoned fireball speeds up exactly like a ghast's.
 */
function summonedAcceleration(fields: Record<string, unknown>): number | undefined {
  const explicit = fields.acceleration_power;
  if (typeof explicit === "number") return explicit;
  const power = fields.power;
  if (Array.isArray(power) && power.length === 3) {
    const [x, y, z] = power as number[];
    return Math.sqrt(x * x + y * y + z * z);
  }
  return undefined;
}

const files = listVectorFiles();

describe("measured golden vectors", () => {
  it("covers every version the calculator claims", () => {
    expect(files.map((f) => f.version)).toEqual(VERSIONS);
  });

  for (const { version, file } of files) {
    describe(`${version} (${file.method})`, () => {
      it("declares whether it was measured", () => {
        expect(file.measured).toBe(file.method === "rcon-e2e");
      });

      /* ---- source derived versions: exact constants ---- */

      for (const c of file.sourceConstants ?? []) {
        const projectile = TYPE_TO_PROJECTILE[c.type];
        if (!projectile) {
          it.skip(`${c.type}: not modeled by this tool`, () => {});
          continue;
        }
        it(`${c.type} constants match the source the pipeline read`, () => {
          const def = PROJECTILE_BY_ID[projectile];
          const { drag, gravity, waterDrag, speedMultiplier } = c.constants;

          if (drag) expect(def.airDrag).toBe(drag.value);
          if (gravity) expect(def.gravity).toBe(gravity.value);
          if (waterDrag) expect(def.waterDrag).toBe(waterDrag.value);
          if (speedMultiplier) {
            expect(def.family).toBe("firework");
            expect(def.shotAtAngle).toBe(false);
            expect(speedMultiplier.value).toBe(1.15);
          }

          // The class chain must actually explain where each value came from,
          // which is what stops a base class value shadowing an override such
          // as the trident's own 0.99 water drag.
          for (const leaf of Object.values(c.constants)) {
            expect(c.classChain).toContain(leaf.class);
          }

          // Tie the source read back to the measured modern versions through
          // this tool's own float widening: the pipeline records 0.99 while the
          // running game multiplies by the widened 0.9900000095367432.
          if (c.modernReference && def.family !== "firework") {
            expect(Math.fround(def.airDrag)).toBe(c.modernReference.drag);
            expect(def.gravity).toBe(c.modernReference.gravity);
          }
        });
      }

      if (file.sourceConstants) {
        it("resolves the trident's own water drag, not the base class", () => {
          const trident = file.sourceConstants?.find((c) => c.type === "trident");
          expect(trident?.constants.waterDrag?.value).toBe(0.99);
          expect(trident?.constants.waterDrag?.class).toBe("ThrownTrident");
          expect(PROJECTILE_BY_ID.trident.waterDrag).toBe(0.99);
          expect(PROJECTILE_BY_ID.arrow.waterDrag).toBe(0.6);
          expect(PROJECTILE_BY_ID.spectral_arrow.waterDrag).toBe(0.6);
        });
      }

      /* ---- measured versions: every tick, exactly ---- */

      for (const c of file.cases ?? []) {
        const projectile = TYPE_TO_PROJECTILE[c.type];
        if (!projectile) {
          it.skip(`${c.type} ${c.launch}: not modeled by this tool`, () => {});
          continue;
        }

        it(`${c.type} ${c.launch} matches every measured tick exactly`, () => {
          const measured = c.series.filter(
            (s) => c.expiredAtTick === null || s.tick <= c.expiredAtTick,
          );
          expect(measured.length).toBeGreaterThan(1);
          // Tick 0 is the post summon state, so it must be the launch state.
          expect(measured[0].tick).toBe(0);
          expect(measured[0].pos).toEqual(c.origin);
          expect(measured[0].motion).toEqual(c.motion);

          const r = simulate({
            version,
            projectile,
            origin: { x: c.origin[0], y: c.origin[1], z: c.origin[2] },
            motion: { x: c.motion[0], y: c.motion[1], z: c.motion[2] },
            accelerationPower: summonedAcceleration(c.initialFields),
            maxTicks: measured[measured.length - 1].tick,
          });
          expect(r.ticks.length).toBeGreaterThanOrEqual(measured.length);
          for (const s of measured) {
            const got = r.ticks[s.tick];
            expect(got, `tick ${s.tick} missing`).toBeDefined();
            expect([got.x, got.y, got.z], `pos at tick ${s.tick}`).toEqual(s.pos);
            expect([got.vx, got.vy, got.vz], `motion at tick ${s.tick}`).toEqual(s.motion);
          }
        });
      }
    });
  }
});

/**
 * The two version boundaries the harness confirmed independently, asserted
 * against the measured files rather than against this tool's own constants.
 */
describe("measured version boundaries", () => {
  function caseFor(version: VersionId, type: string, launch: string): VectorCase | undefined {
    const entry = files.find((f) => f.version === version);
    return entry?.file.cases?.find((c) => c.type === type && c.launch === launch);
  }

  it("swaps thrown item gravity and drag order between 1.21.1 and 1.21.11", () => {
    // Before the movement rewrite a thrown item moves first, so its first tick
    // of vertical motion is exactly minus gravity. After it, gravity lands
    // before the drag, so the first tick already carries the 0.99 factor.
    const before = caseFor("1.21.1", "snowball", "flat-fast");
    const after = caseFor("1.21.11", "snowball", "flat-fast");
    if (!before || !after) return;
    expect(before.series[1].motion[1]).toBe(-0.03);
    expect(after.series[1].motion[1]).toBe(-0.03 * Math.fround(0.99));
    expect(after.series[1].motion[1]).toBe(-0.029700000286102295);
  });

  it("gives a summoned fireball acceleration only from 1.21.1", () => {
    const before = caseFor("1.20.6", "fireball", "flat-fast");
    const after = caseFor("1.21.1", "fireball", "flat-fast");
    if (!before || !after) return;
    expect(before.initialFields).toEqual({ power: [0, 0, 0] });
    expect(after.initialFields).toEqual({ acceleration_power: 0.1 });
    expect(before.series[1].motion[0]).toBe(3 * Math.fround(0.95));
    expect(after.series[1].motion[0]).toBe((3 + 0.1) * Math.fround(0.95));
  });

  it("reproduces both fireball shapes with the acceleration the fields declare", () => {
    for (const version of ["1.20.6", "1.21.1", "1.21.11", "26.2"] as VersionId[]) {
      for (const launch of ["flat-fast", "angled"]) {
        const c = caseFor(version, "fireball", launch);
        if (!c) continue;
        const r = simulate({
          version,
          projectile: "fireball",
          origin: { x: c.origin[0], y: c.origin[1], z: c.origin[2] },
          motion: { x: c.motion[0], y: c.motion[1], z: c.motion[2] },
          accelerationPower: summonedAcceleration(c.initialFields),
          maxTicks: 12,
        });
        const last = c.series[c.series.length - 1];
        expect([r.ticks[last.tick].x, r.ticks[last.tick].y, r.ticks[last.tick].z]).toEqual(
          last.pos,
        );
      }
    }
  });
});
