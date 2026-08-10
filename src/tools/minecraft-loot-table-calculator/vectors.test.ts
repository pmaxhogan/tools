import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculate, type CalcOptions } from "./index";

/**
 * Statistical golden-vector suite.
 *
 * mc-pipeline/04-harness.mjs booted a REAL dedicated server for each of the
 * six shipped versions and measured actual loot rolls over RCON:
 *
 * - perRoll: 400 full generations per flagship table/tool combo, recorded as
 *   a histogram over exact per-generation outcomes ("item:count,..." keys).
 * - bulk: 1000 generations per remaining block table (bare diamond pickaxe)
 *   and 600 kill-context generations for five mobs, recorded as aggregate
 *   item totals.
 *
 * The engine's analytically derived distributions are asserted against those
 * measurements with 4-sigma statistical bounds. Any outcome that was
 * OBSERVED on the real server but gets probability 0 from the engine is a
 * hard failure (the reverse direction is fine: a possible outcome may simply
 * not have occurred in 400 rolls).
 *
 * Measurement context, mirrored exactly here (do not let UI defaults leak in):
 * - blocks were mined via `loot insert <chest> mine <pos> <tool>` with a
 *   diamond pickaxe (bare or enchanted). Blocks were placed with default
 *   block states (crops at age=0), EXCEPT wheat which was placed as
 *   wheat[age=7]. The engine's cropMature flag reproduces both.
 *   With default states, state-gated pools drop nothing: that also covers
 *   tall_grass, where in-game drops additionally require the other half of
 *   the plant to be present (a location_check this tool models as false),
 *   which setblock also does not place. Both model and measurement agree on
 *   "nothing", so no exclusions are needed.
 * - mobs were rolled via `loot insert <chest> kill <entity>` with no
 *   attacker: killed_by_player is FALSE, looting 0, mob not on fire.
 *
 * Exclusions: none at the table level; every vector entry in every version
 * file is asserted. One narrowly scoped measurement artifact is tolerated:
 * gravel is a FALLING block, and when the harness's setblock/loot-mine
 * command pair straddled a server tick boundary the freshly placed gravel
 * started falling and the mine hit air, recording a bogus "nothing" roll
 * (observed exactly 1/400 times in 1.18.2, 1.20.6, and 26.2, and never for
 * any non-falling block). The gravel loot table itself cannot roll an empty
 * result: pool 1 always yields flint or gravel. So an observed "nothing" on
 * a falling-block table is skipped when it is within 0.5% of rolls; any
 * other engine-probability-zero observation remains a hard failure.
 */

/** Tables for falling blocks, where the setblock race can void a measured roll. */
const FALLING_BLOCK_TABLES = new Set(["blocks/gravel"]);

const VECTORS_DIR = fileURLToPath(new URL("../../../mc-pipeline/vectors/loot/", import.meta.url));

interface PerRollVector {
  rolls: number;
  histogram: Record<string, number>;
}
interface BulkVector {
  rolls: number;
  totals: Record<string, number>;
}
interface VectorFile {
  version: string;
  method: string;
  perRoll: Record<string, PerRollVector>;
  bulk: Record<string, BulkVector>;
}

const files = readdirSync(VECTORS_DIR).filter((f) => f.endsWith(".json"));

/** "blocks/diamond_ore|fortune3" -> calculate() options mirroring the harness. */
function contextFor(version: string, key: string): CalcOptions {
  const [rawTable, toolSpec] = key.split("|");
  const table = rawTable.includes("/") ? rawTable : `blocks/${rawTable}`;
  const isEntity = table.startsWith("entities/");
  const opts: CalcOptions = {
    version,
    table,
    // Harness context: blocks mined with a diamond pickaxe; mob loot rolled
    // with no attacker at all (loot ... kill), so killed_by_player is false.
    tool: isEntity ? "none" : "pickaxe",
    killedByPlayer: false,
    looting: 0,
    onFire: false,
    // Blocks were placed with setblock defaults (age=0), except wheat[age=7].
    cropMature: table === "blocks/wheat",
  };
  const fortune = toolSpec.match(/^fortune(\d)$/);
  if (fortune) opts.fortune = Number(fortune[1]);
  if (toolSpec.startsWith("silk_touch")) opts.silkTouch = true;
  return opts;
}

for (const file of files) {
  const vec = JSON.parse(readFileSync(VECTORS_DIR + file, "utf8")) as VectorFile;
  const version = vec.version;

  describe(`golden vectors ${version} (${vec.method})`, () => {
    describe("perRoll outcome histograms", () => {
      for (const [key, data] of Object.entries(vec.perRoll)) {
        it(`${key}: engine distribution matches ${data.rolls} measured rolls`, () => {
          const result = calculate(contextFor(version, key));
          expect(result.outcomes, "flagship tables must have a tractable joint").not.toBeNull();
          const engine = new Map(result.outcomes!.map((o) => [o.key, o.p]));
          const n = data.rolls;

          const table = contextFor(version, key).table;
          for (const [outcome, observed] of Object.entries(data.histogram)) {
            const p = engine.get(outcome) ?? 0;
            if (
              outcome === "nothing" &&
              p === 0 &&
              FALLING_BLOCK_TABLES.has(table) &&
              observed <= Math.ceil(n * 0.005)
            ) {
              continue; // falling-block tick race, see header comment
            }
            expect(
              p,
              `outcome "${outcome}" was observed ${observed}x on the real server but the engine gives it probability 0`,
            ).toBeGreaterThan(0);
            const tolerance = 4 * Math.sqrt(n * p * (1 - p)) + 2;
            expect(
              Math.abs(observed - n * p),
              `outcome "${outcome}": observed ${observed}, expected ${(n * p).toFixed(1)} +/- ${tolerance.toFixed(1)}`,
            ).toBeLessThanOrEqual(tolerance);
          }

          // The engine's outcome space must be a full probability distribution.
          const total = result.outcomes!.reduce((s, o) => s + o.p, 0);
          expect(total).toBeCloseTo(1, 6);
        });
      }
    });

    describe("bulk aggregate totals", () => {
      for (const [key, data] of Object.entries(vec.bulk)) {
        it(`${key}: expected totals within 4 sigma over ${data.rolls} rolls`, () => {
          const result = calculate(contextFor(version, key));
          const n = data.rolls;
          const byItem = new Map(result.items.map((i) => [i.item, i]));

          const allItems = new Set([...Object.keys(data.totals), ...byItem.keys()]);
          for (const item of allItems) {
            const row = byItem.get(item);
            const mean = row?.expected ?? 0;
            const varPerRoll = row?.variance ?? 0;
            const observed = data.totals[item] ?? 0;
            const tolerance = 4 * Math.sqrt(n * varPerRoll) + 2;
            expect(
              Math.abs(observed - n * mean),
              `${item}: observed ${observed}, expected ${(n * mean).toFixed(1)} +/- ${tolerance.toFixed(1)}`,
            ).toBeLessThanOrEqual(tolerance);
          }
        });
      }
    });
  });
}

it("covers all six versions", () => {
  expect(files.length).toBe(6);
});
