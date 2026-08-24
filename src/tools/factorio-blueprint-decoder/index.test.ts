import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { run, splitVersion, isEnvironmentEntity, itemRequestCounts } from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ */
/* fixtures: encode first with a real zlib, then let the tool decode   */
/* ------------------------------------------------------------------ */

/** version byte + base64(zlib deflate(JSON)), built independently of the tool. */
function encodeFixture(root: unknown): string {
  const json = JSON.stringify(root);
  return "0" + deflateSync(Buffer.from(json, "utf8")).toString("base64");
}

function rawFixture(payload: string | Uint8Array, versionByte = "0"): string {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  return versionByte + deflateSync(bytes).toString("base64");
}

const VERSION_1_1_110 = 281479278886912;

function belt(entityNumber: number, x: number, y: number, name = "transport-belt") {
  return { entity_number: entityNumber, name, position: { x, y } };
}

const SIMPLE_BLUEPRINT = {
  blueprint: {
    item: "blueprint",
    label: "Red Belt Lane",
    description: "A short test lane.",
    version: VERSION_1_1_110,
    icons: [{ signal: { type: "item", name: "fast-transport-belt" }, index: 1 }],
    entities: [
      belt(1, 0, 0),
      belt(2, 1, 0),
      belt(3, 2, 0),
      belt(4, 0, 2, "inserter"),
      belt(5, 4, 2, "inserter"),
      belt(6, 4, 0, "fast-inserter"),
    ],
    tiles: [
      { name: "concrete", position: { x: 0, y: 0 } },
      { name: "concrete", position: { x: 1, y: 0 } },
    ],
  },
};

const BOOK = {
  blueprint_book: {
    item: "blueprint-book",
    label: "Starter Base",
    version: VERSION_1_1_110,
    active_index: 0,
    icons: [{ signal: { type: "item", name: "blueprint-book" }, index: 1 }],
    blueprints: [
      {
        index: 0,
        blueprint: {
          item: "blueprint",
          label: "Smelter Column",
          version: VERSION_1_1_110,
          entities: [belt(1, 0, 0, "stone-furnace"), belt(2, 3, 0, "stone-furnace")],
        },
      },
      {
        index: 1,
        blueprint: {
          item: "blueprint",
          label: "Miner Row",
          version: VERSION_1_1_110,
          entities: [belt(1, 0, 0, "electric-mining-drill")],
        },
      },
    ],
  },
};

describe("factorio-blueprint-decoder: format handling", () => {
  it("decodes a zlib-built string and returns the JSON payload unchanged", async () => {
    const out = await run(encodeFixture(SIMPLE_BLUEPRINT), { operation: "json" });
    expect(JSON.parse(out)).toEqual(SIMPLE_BLUEPRINT);
    expect(out).toBe(JSON.stringify(SIMPLE_BLUEPRINT, null, 2));
  });

  it("re-encodes JSON into a string that decodes back to the same JSON", async () => {
    const encoded = await run(JSON.stringify(SIMPLE_BLUEPRINT), { operation: "reencode" });
    expect(encoded.startsWith("0")).toBe(true);
    expect(encoded).toMatch(/^0[A-Za-z0-9+/]+={0,2}$/);
    const back = await run(encoded, { operation: "json" });
    expect(JSON.parse(back)).toEqual(SIMPLE_BLUEPRINT);
  });

  it("round-trips a fixture through decode and encode without losing a byte", async () => {
    const fixture = encodeFixture(BOOK);
    const json = await run(fixture, { operation: "json" });
    const reencoded = await run(json, { operation: "reencode" });
    expect(await run(reencoded, { operation: "json" })).toBe(json);
  });

  it("decodes the packed version number into major.minor.patch.dev", () => {
    expect(splitVersion(VERSION_1_1_110)).toBe("1.1.110.0");
    expect(splitVersion(281479271677952)).toBe("1.1.0.0");
    expect(splitVersion("nope")).toBeNull();
  });
});

describe("factorio-blueprint-decoder: inspect", () => {
  it("summarizes a blueprint with counts, icons, tiles and a footprint", async () => {
    const out = await run(encodeFixture(SIMPLE_BLUEPRINT), {});
    expect(out).toContain("Blueprint: Red Belt Lane");
    expect(out).toContain("Game version: 1.1.110.0");
    expect(out).toContain("item/fast-transport-belt");
    expect(out).toContain("6 entities, 3 distinct names");
    expect(out).toContain("2 tiles (concrete 2)");
    expect(out).toContain("Footprint: 5 x 3 tiles (x 0 to 4, y 0 to 2)");
  });

  it("counts entities by name, highest first", async () => {
    const out = await run(encodeFixture(SIMPLE_BLUEPRINT), { operation: "inspect" });
    const order = ["transport-belt", "inserter", "fast-inserter"].map((n) =>
      out.indexOf(`\n    ${n}`),
    );
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1] as number);
    expect(order[1]).toBeLessThan(order[2] as number);
  });

  it("recurses into a blueprint book with two nested blueprints", async () => {
    const out = await run(encodeFixture(BOOK), { operation: "inspect" });
    expect(out).toContain("Blueprint book: Starter Base");
    expect(out).toContain("Contains: 2 entries");
    expect(out).toContain("[0] Blueprint: Smelter Column");
    expect(out).toContain("[1] Blueprint: Miner Row");
    expect(out).toContain("stone-furnace");
    expect(out).toContain("electric-mining-drill");
  });

  it("reports item requests and circuit connections in both the 1.x and 2.0 shapes", async () => {
    const wired = {
      blueprint: {
        item: "blueprint",
        label: "Wired",
        version: VERSION_1_1_110,
        entities: [
          {
            entity_number: 1,
            name: "assembling-machine-3",
            position: { x: 0, y: 0 },
            items: { "speed-module-3": 4 },
            connections: { "1": { green: [{ entity_id: 2 }] } },
          },
          {
            entity_number: 2,
            name: "beacon",
            position: { x: 3, y: 0 },
            items: [
              {
                id: { name: "speed-module-3", quality: "normal" },
                items: { in_inventory: [{ inventory: 1, stack: 0, count: 2 }] },
              },
            ],
            connections: { "1": { green: [{ entity_id: 1 }] } },
          },
        ],
      },
    };
    const out = await run(encodeFixture(wired), { operation: "inspect" });
    expect(out).toContain("2 entities requesting speed-module-3 x6");
    expect(out).toContain("2 circuit connection endpoints");
  });

  it("names a deconstruction planner instead of crashing on it", async () => {
    const planner = {
      deconstruction_planner: {
        item: "deconstruction-planner",
        label: "Clear Trees",
        version: VERSION_1_1_110,
        settings: { filters: [{ name: "tree-01", index: 1 }] },
      },
    };
    const out = await run(encodeFixture(planner), { operation: "inspect" });
    expect(out).toContain("Deconstruction planner: Clear Trees");
    expect(out).toContain("Filters: 1");
  });
});

describe("factorio-blueprint-decoder: repair", () => {
  /** A fixture whose base64 body definitely contains a plus sign to mangle. */
  function fixtureWithPlus(): string {
    for (let salt = 0; salt < 500; salt++) {
      const candidate = encodeFixture({
        blueprint: {
          item: "blueprint",
          label: `Bus ${salt}`,
          version: VERSION_1_1_110,
          entities: Array.from({ length: 12 }, (_, i) =>
            belt(i + 1, i, salt % 7, `entity-${i}-${salt}`),
          ),
        },
      });
      if (candidate.includes("+")) return candidate;
    }
    throw new Error("no fixture containing a plus sign was produced");
  }

  it("fixes embedded newlines and a URL-encoded plus sign", async () => {
    const good = fixtureWithPlus();
    const withPlus = good.replace("+", "%2B");
    const mangled =
      "  " +
      withPlus.slice(0, 20) +
      "\n" +
      withPlus.slice(20, 60) +
      "\r\n" +
      withPlus.slice(60) +
      "  ";

    await expect(run(mangled, { operation: "inspect" })).rejects.toThrowError(ToolError);

    const out = await run(mangled, { operation: "repair" });
    expect(out).toContain("Removed 3 whitespace characters");
    expect(out).toContain("URL-encoded character");
    const clean = out.trim().split("\n").pop() as string;
    expect(clean).toBe(
      await run(await run(good, { operation: "json" }), { operation: "reencode" }),
    );
  });

  it("restores a missing leading version byte", async () => {
    const good = encodeFixture(SIMPLE_BLUEPRINT);
    const out = await run(good.slice(1), { operation: "repair" });
    expect(out).toContain('Added the missing leading version byte "0".');
    expect(out).toContain("Blueprint: Red Belt Lane");
  });

  it("cuts trailing junk that is not part of the payload", async () => {
    const out = await run(`${encodeFixture(SIMPLE_BLUEPRINT)} <-- paste this!`, {
      operation: "repair",
    });
    expect(out).toContain("of junk that is not part of the base64 payload");
    expect(out).toContain("Blueprint: Red Belt Lane");
  });

  it("says so when nothing needed fixing", async () => {
    const out = await run(encodeFixture(SIMPLE_BLUEPRINT), { operation: "repair" });
    expect(out).toContain("Nothing needed fixing.");
  });

  it("gives up honestly when characters are missing from the middle", async () => {
    await expect(
      run("this string is beyond saving", { operation: "repair" }),
    ).rejects.toMatchObject({
      code: "unrepairable",
    });
  });

  it("rejects empty repair input", async () => {
    await expect(run("   ", { operation: "repair" })).rejects.toMatchObject({
      code: "empty-input",
    });
  });
});

describe("factorio-blueprint-decoder: strip", () => {
  const OVERGROWN = {
    blueprint: {
      item: "blueprint",
      label: "Overgrown",
      version: VERSION_1_1_110,
      entities: [
        belt(1, 0, 0),
        { entity_number: 2, name: "tree-01", position: { x: 1, y: 0 } },
        { entity_number: 3, name: "tree-02", position: { x: 2, y: 0 } },
        { entity_number: 4, name: "rock-huge", position: { x: 3, y: 0 } },
        {
          entity_number: 5,
          name: "assembling-machine-3",
          position: { x: 5, y: 0 },
          items: { "productivity-module-3": 4 },
        },
      ],
      tiles: [{ name: "landfill", position: { x: 0, y: 0 } }],
    },
  };

  it("removes trees and rocks, reports them, and keeps entity numbers", async () => {
    const out = await run(encodeFixture(OVERGROWN), { operation: "strip" });
    expect(out).toContain("Removed 3 environment entities: rock-huge x1, tree-01 x1, tree-02 x1");
    const clean = out.trim().split("\n").pop() as string;
    const json = JSON.parse(await run(clean, { operation: "json" }));
    const entities = json.blueprint.entities as { entity_number: number; name: string }[];
    expect(entities.map((e) => e.name)).toEqual(["transport-belt", "assembling-machine-3"]);
    expect(entities.map((e) => e.entity_number)).toEqual([1, 5]);
    expect(json.blueprint.tiles).toHaveLength(1);
  });

  it("clears item requests and removes tiles when asked", async () => {
    const out = await run(encodeFixture(OVERGROWN), {
      operation: "strip",
      stripTrees: false,
      stripRequests: true,
      stripTiles: true,
    });
    expect(out).toContain("Cleared item requests on 1 entity (4 requested items).");
    expect(out).toContain("Removed the tile layer (1 tile).");
    const clean = out.trim().split("\n").pop() as string;
    const json = JSON.parse(await run(clean, { operation: "json" }));
    expect(json.blueprint.tiles).toBeUndefined();
    expect(json.blueprint.entities).toHaveLength(5);
    expect(json.blueprint.entities[4].items).toBeUndefined();
  });

  it("reports an honest no-op when every toggle is off", async () => {
    const out = await run(encodeFixture(OVERGROWN), {
      operation: "strip",
      stripTrees: false,
      stripRequests: false,
      stripTiles: false,
    });
    expect(out).toContain("No strip options were selected");
  });

  it("strips inside every blueprint of a book", async () => {
    const book = {
      blueprint_book: {
        item: "blueprint-book",
        label: "Both",
        version: VERSION_1_1_110,
        blueprints: [
          { index: 0, ...OVERGROWN },
          { index: 1, ...OVERGROWN },
        ],
      },
    };
    const out = await run(encodeFixture(book), { operation: "strip" });
    expect(out).toContain("Removed 6 environment entities");
  });
});

describe("factorio-blueprint-decoder: errors", () => {
  it("throws empty-input on an empty string", async () => {
    await expect(run("   \n ", {})).rejects.toMatchObject({ code: "empty-input" });
  });

  it("names the version byte it found when it is not 0", async () => {
    const bad = "1" + encodeFixture(SIMPLE_BLUEPRINT).slice(1);
    await expect(run(bad, {})).rejects.toMatchObject({ code: "unsupported-version" });
    await expect(run(bad, {})).rejects.toThrowError(/version byte "1"/);
  });

  it("throws invalid-base64 on characters outside the alphabet", async () => {
    const err = await run("0abcd$$$efgh", {}).catch((e: ToolError) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("invalid-base64");
    expect((err as ToolError).fix).toMatch(/repair/);
  });

  it("throws invalid-compression when the bytes are not a deflate stream", async () => {
    const notZlib = "0" + Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).toString("base64");
    await expect(run(notZlib, {})).rejects.toMatchObject({ code: "invalid-compression" });
  });

  it("throws invalid-json when the payload decompresses to something else", async () => {
    await expect(run(rawFixture("this is definitely not json"), {})).rejects.toMatchObject({
      code: "invalid-json",
    });
  });

  it("throws invalid-json when the payload is a JSON array", async () => {
    await expect(run(rawFixture("[1,2,3]"), {})).rejects.toMatchObject({ code: "invalid-json" });
  });

  it("throws empty-payload when only the version byte is present", async () => {
    await expect(run("0", {})).rejects.toMatchObject({ code: "empty-payload" });
  });

  it("rejects re-encoding JSON with no blueprint root", async () => {
    const err = await run('{"hello":1}', { operation: "reencode" }).catch((e: ToolError) => e);
    expect((err as ToolError).code).toBe("not-a-blueprint");
    expect((err as ToolError).fix).toMatch(/blueprint_book/);
  });

  it("rejects invalid JSON and empty input on re-encode", async () => {
    await expect(run("{oops}", { operation: "reencode" })).rejects.toMatchObject({
      code: "invalid-json",
    });
    await expect(run("", { operation: "reencode" })).rejects.toMatchObject({ code: "empty-input" });
  });

  it("rejects an operation it does not know", async () => {
    await expect(run("0abc", { operation: "explode" as never })).rejects.toMatchObject({
      code: "unknown-operation",
    });
  });
});

describe("factorio-blueprint-decoder: helpers", () => {
  it("recognizes environment entities without eating real machines", () => {
    for (const name of [
      "tree-01",
      "dead-dry-hairy-tree",
      "rock-huge",
      "sand-rock-big",
      "fish",
      "dead-gray-trunk",
    ])
      expect(isEnvironmentEntity(name)).toBe(true);
    for (const name of ["transport-belt", "assembling-machine-3", "rocket-silo", "stone-furnace"])
      expect(isEnvironmentEntity(name)).toBe(false);
  });

  it("normalizes both item request shapes to name and count", () => {
    expect(itemRequestCounts({ "speed-module-3": 2 })).toEqual({ "speed-module-3": 2 });
    expect(
      itemRequestCounts([
        { id: { name: "speed-module-3" }, items: { in_inventory: [{ count: 2 }, { count: 1 }] } },
      ]),
    ).toEqual({ "speed-module-3": 3 });
    expect(itemRequestCounts(undefined)).toEqual({});
  });
});
