import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VILLAGER_DATA, VILLAGER_VERSIONS, type TradeRow } from "./data";

/**
 * Golden-vector suite for the trade tables.
 *
 * mc-pipeline booted a real dedicated server per version and summoned 200
 * villagers for every profession and level, then read their generated
 * Offers.Recipes back over RCON and aggregated them per distinct
 * (buy, buyB, sell) triple. Each measured entry carries the observed cost
 * range, the xp, the price multiplier and the max uses actually present in
 * the NBT, plus how many of the 200 villagers rolled it.
 *
 * Two directions are asserted:
 *
 * 1. Every trade the server really generated exists in the shipped data with
 *    matching attributes, and the measured cost range sits inside the range
 *    this tool claims. Randomised trades (enchanted books, enchanted gear)
 *    legitimately show a narrower measured range than the theoretical one.
 * 2. Every trade the shipped data claims was really generated, with two
 *    documented exclusions:
 *    - Explorer map trades. TreasureMapForEmeralds returns no offer when the
 *      structure search fails, and the harness world is generated without
 *      structures, so no villager in any version ever rolled one. The
 *      measurements contain zero filled_map trades, which is consistent
 *      rather than contradictory.
 *    - Villager-type restricted trades. The harness summoned one villager
 *      type, so only that type's variant of a biome-gated trade can appear.
 *      Those rows are still checked in direction 1 whenever they were seen.
 *
 * The suite scales automatically: it asserts against whichever version files
 * are present under mc-pipeline/vectors/villager/.
 */

const VECTORS_DIR = fileURLToPath(
  new URL("../../../mc-pipeline/vectors/villager/", import.meta.url),
);

interface MeasuredSide {
  id: string;
  detail: string | null;
  countMin: number;
  countMax: number;
}
interface MeasuredTrade {
  key: string;
  buy: MeasuredSide;
  buyB: MeasuredSide | null;
  sell: MeasuredSide;
  xp: number[];
  priceMultiplier: number[];
  maxUses: number[];
  offers: number;
  offeredBy: number;
}
interface MeasuredCell {
  samples: number;
  recipesPerVillager?: Record<string, number>;
  trades?: MeasuredTrade[];
}
interface VectorFile {
  version: string;
  method: string;
  samplesPerCell: number;
  professionsWithoutTrades: string[];
  professions: Record<string, Record<string, MeasuredCell>>;
}

const stripNs = (id: string) => id.replace(/^minecraft:/, "");
const tradeKey = (wants: string, second: string, gives: string) => `${wants}|${second}|${gives}`;

const files = existsSync(VECTORS_DIR)
  ? readdirSync(VECTORS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
  : [];

/** A shipped row whose absence from the measurements is expected, see the header. */
function excusedFromMeasurement(row: TradeRow): boolean {
  return row[10] === "map" || row[11] !== "";
}

for (const file of files) {
  const vec = JSON.parse(readFileSync(VECTORS_DIR + file, "utf8")) as VectorFile;
  const data = VILLAGER_DATA[vec.version];

  describe(`golden vectors ${vec.version} (${vec.method})`, () => {
    it("is a version this tool ships data for", () => {
      expect(VILLAGER_VERSIONS).toContain(vec.version);
      expect(data).toBeDefined();
    });

    for (const [profession, levels] of Object.entries(vec.professions)) {
      const shipped = data?.professions[profession];

      if (!shipped) {
        it(`${profession} is correctly absent from the shipped tables`, () => {
          expect(vec.professionsWithoutTrades).toContain(profession);
        });
        continue;
      }

      for (const [level, cell] of Object.entries(levels)) {
        const rows = shipped.levels[level] ?? [];
        const measured = cell.trades ?? [];
        if (!measured.length) continue;

        it(`${profession} level ${level}: every measured trade is in the shipped table`, () => {
          const byKey = new Map<string, TradeRow[]>();
          for (const row of rows) {
            const key = tradeKey(row[0], row[8], row[3]);
            const list = byKey.get(key);
            if (list) list.push(row);
            else byKey.set(key, [row]);
          }

          for (const trade of measured) {
            const key = tradeKey(
              stripNs(trade.buy.id),
              trade.buyB ? stripNs(trade.buyB.id) : "",
              stripNs(trade.sell.id),
            );
            const candidates = byKey.get(key);
            expect(
              candidates,
              `${vec.version} ${profession} ${level}: "${trade.key}" was rolled by ${trade.offeredBy} of ${cell.samples} real villagers but is not in the shipped table`,
            ).toBeDefined();

            const match = candidates!.find(
              (row) =>
                trade.buy.countMin >= row[1] &&
                trade.buy.countMax <= row[2] &&
                trade.sell.countMin === row[4] &&
                trade.sell.countMax === row[4] &&
                (trade.maxUses.length === 0 || trade.maxUses.includes(row[5])) &&
                // The xp tag is omitted from the recipe NBT when it is the
                // default 1, which is why an empty array asserts xp 1.
                (trade.xp.length === 0 ? row[6] === 1 : trade.xp.includes(row[6])) &&
                (trade.priceMultiplier.length === 0 ||
                  trade.priceMultiplier.some((m) => Math.abs(m - row[7]) < 1e-6)),
            );
            expect(
              match,
              `${vec.version} ${profession} ${level}: "${trade.key}" measured as cost ${trade.buy.countMin} to ${trade.buy.countMax}, sell ${trade.sell.countMin}, xp ${JSON.stringify(trade.xp)}, multiplier ${JSON.stringify(trade.priceMultiplier)}, max uses ${JSON.stringify(trade.maxUses)}, which no shipped row matches: ${JSON.stringify(candidates)}`,
            ).toBeDefined();
          }
        });

        it(`${profession} level ${level}: every shipped trade really appeared`, () => {
          const seen = new Set(
            measured.map((trade) =>
              tradeKey(
                stripNs(trade.buy.id),
                trade.buyB ? stripNs(trade.buyB.id) : "",
                stripNs(trade.sell.id),
              ),
            ),
          );
          for (const row of rows) {
            if (excusedFromMeasurement(row)) continue;
            expect(
              seen.has(tradeKey(row[0], row[8], row[3])),
              `${vec.version} ${profession} ${level}: the shipped table claims ${row[1]} ${row[0]} for ${row[4]} ${row[3]}, which never appeared across ${cell.samples} real villagers`,
            ).toBe(true);
          }
        });

        it(`${profession} level ${level}: villagers carried no more trades than the pool offers`, () => {
          const offered = shipped.offered[Number(level) - 1];
          for (const count of Object.keys(cell.recipesPerVillager ?? {})) {
            expect(
              Number(count),
              `${vec.version} ${profession} ${level}: a villager carried ${count} trades from a pool that offers ${offered}`,
            ).toBeLessThanOrEqual(offered);
          }
        });
      }
    }
  });
}

it("has measured vectors to assert against", () => {
  expect(
    files.length,
    "no villager vector files found under mc-pipeline/vectors/villager/",
  ).toBeGreaterThan(0);
  for (const file of files) {
    expect(VILLAGER_VERSIONS).toContain(file.replace(/\.json$/, ""));
  }
});
