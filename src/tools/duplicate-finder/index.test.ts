import { describe, expect, it } from "vitest";
import { MAX_HASH_BYTES, type FsFileEntry, type FsScan } from "@/lib/fs-access";
import {
  EMPTY_FILE_HASH,
  chooseDeletions,
  chooseKeeper,
  describePlan,
  emptyFileGroup,
  groupByHash,
  groupBySize,
  humanBytes,
  isUnreadable,
  planDeletions,
  planHashing,
  run,
  summarize,
  type DuplicateGroup,
} from "./index";

/* ------------------------------------------------------------------ *
 * fixtures: an FsScan built by hand, exactly as the contract intends
 * ------------------------------------------------------------------ */

function file(path: string, size: number, lastModified = 1_700_000_000_000): FsFileEntry {
  const parts = path.split("/");
  return {
    kind: "file",
    name: parts[parts.length - 1] as string,
    path,
    size,
    lastModified,
  };
}

function scanOf(entries: FsFileEntry[]): FsScan {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    rootName: "photos",
    entries: sorted,
    directories: [],
    totalBytes: sorted.reduce((sum, e) => sum + e.size, 0),
    fileCount: sorted.length,
    truncated: false,
    depthCapped: false,
  };
}

function group(hash: string, size: number, files: FsFileEntry[]): DuplicateGroup {
  return { hash, size, files, wastedBytes: size * (files.length - 1) };
}

/* ------------------------------------------------------------------ *
 * step 1: size grouping
 * ------------------------------------------------------------------ */

describe("groupBySize", () => {
  it("keeps only the sizes more than one file shares", () => {
    const scan = scanOf([
      file("a.jpg", 100),
      file("b.jpg", 100),
      file("c.jpg", 250),
      file("d/e.jpg", 900),
      file("d/f.jpg", 900),
      file("d/g.jpg", 900),
    ]);

    const buckets = groupBySize(scan);

    expect([...buckets.keys()]).toEqual([100, 900]);
    expect(buckets.get(100)?.map((e) => e.path)).toEqual(["a.jpg", "b.jpg"]);
    expect(buckets.get(900)).toHaveLength(3);
    // 250 is a size only one file has, so it can never be a content match.
    expect(buckets.has(250)).toBe(false);
  });

  it("leaves zero byte files out of the candidate set entirely", () => {
    const scan = scanOf([file("empty-a.log", 0), file("empty-b.log", 0), file("real.log", 12)]);
    expect(groupBySize(scan).size).toBe(0);
  });

  it("returns nothing for an empty scan", () => {
    expect(groupBySize(scanOf([])).size).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * step 2: the hashing plan
 * ------------------------------------------------------------------ */

describe("planHashing", () => {
  it("counts what gets hashed and what was ruled out by size", () => {
    const entries: FsFileEntry[] = [];
    // 20 files that each have a unique size, so none of them can have a twin.
    for (let i = 0; i < 20; i += 1) entries.push(file(`unique/${i}.bin`, 1000 + i));
    // Two pairs that do collide on size.
    entries.push(file("pair-a-1.bin", 5000), file("pair-a-2.bin", 5000));
    entries.push(file("pair-b-1.bin", 6000), file("pair-b-2.bin", 6000));

    const plan = planHashing(scanOf(entries));

    expect(plan.totalFiles).toBe(24);
    expect(plan.candidateCount).toBe(4);
    expect(plan.files.map((e) => e.path)).toEqual([
      "pair-a-1.bin",
      "pair-a-2.bin",
      "pair-b-1.bin",
      "pair-b-2.bin",
    ]);
    expect(plan.uniqueBySize).toBe(20);
    expect(plan.bytesToHash).toBe(5000 * 2 + 6000 * 2);
    expect(plan.sizeOnlyGroups).toEqual([]);
    expect(plan.unreadable).toEqual([]);
    expect(describePlan(plan)).toContain("Hashing 4 of 24 files");
  });

  it("reports files past the hashing ceiling as a size only group instead of hashing them", () => {
    const big = MAX_HASH_BYTES + 1;
    const scan = scanOf([
      file("video/master-1.mov", big),
      file("video/master-2.mov", big),
      file("small-1.txt", 40),
      file("small-2.txt", 40),
    ]);

    const plan = planHashing(scan);

    expect(plan.files.map((e) => e.path)).toEqual(["small-1.txt", "small-2.txt"]);
    expect(plan.bytesToHash).toBe(80);
    expect(plan.sizeOnlyGroups).toHaveLength(1);
    expect(plan.sizeOnlyGroups[0]?.map((e) => e.path)).toEqual([
      "video/master-1.mov",
      "video/master-2.mov",
    ]);
  });

  it("separates zero byte files from files the scan could not read", () => {
    const locked = file("locked.db", 0, 0);
    const scan = scanOf([
      file("a/empty.txt", 0),
      file("b/empty.txt", 0),
      locked,
      file("real.txt", 10),
    ]);

    const plan = planHashing(scan);

    expect(isUnreadable(locked)).toBe(true);
    expect(plan.emptyFiles.map((e) => e.path)).toEqual(["a/empty.txt", "b/empty.txt"]);
    expect(plan.unreadable.map((e) => e.path)).toEqual(["locked.db"]);
    expect(plan.candidateCount).toBe(0);
    // The locked file is never offered as an empty duplicate, because its bytes
    // are unknown rather than absent.
    expect(emptyFileGroup(scan)?.files.map((e) => e.path)).toEqual(["a/empty.txt", "b/empty.txt"]);
  });

  it("says so plainly when nothing needs hashing", () => {
    const plan = planHashing(scanOf([file("a.txt", 1), file("b.txt", 2)]));
    expect(plan.candidateCount).toBe(0);
    expect(describePlan(plan)).toContain("nothing to hash");
  });
});

/* ------------------------------------------------------------------ *
 * step 3: hash grouping
 * ------------------------------------------------------------------ */

describe("groupByHash", () => {
  it("does not group files that share a size but not a hash", () => {
    const groups = groupByHash([
      { entry: file("a.bin", 4096), hash: "aaaa" },
      { entry: file("b.bin", 4096), hash: "bbbb" },
    ]);
    expect(groups).toEqual([]);
  });

  it("builds a three way group with the right wasted space", () => {
    const groups = groupByHash([
      { entry: file("photos/holiday.jpg", 2_000_000), hash: "ffff" },
      { entry: file("backup/holiday.jpg", 2_000_000), hash: "ffff" },
      { entry: file("archive/copy of holiday.jpg", 2_000_000), hash: "ffff" },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.files).toHaveLength(3);
    // Two of the three copies are waste; the third is the file itself.
    expect(groups[0]?.wastedBytes).toBe(4_000_000);
    expect(groups[0]?.files.map((e) => e.path)).toEqual([
      "archive/copy of holiday.jpg",
      "backup/holiday.jpg",
      "photos/holiday.jpg",
    ]);
  });

  it("sorts groups by wasted space, largest first, whatever order hashes arrive in", () => {
    const groups = groupByHash([
      { entry: file("small-1.bin", 10), hash: "cccc" },
      { entry: file("big-1.bin", 5000), hash: "dddd" },
      { entry: file("small-2.bin", 10), hash: "cccc" },
      { entry: file("big-2.bin", 5000), hash: "dddd" },
    ]);

    expect(groups.map((g) => g.hash)).toEqual(["dddd", "cccc"]);
    expect(groups.map((g) => g.wastedBytes)).toEqual([5000, 10]);
  });

  it("never invents a duplicate from the same file hashed twice", () => {
    const entry = file("once.bin", 99);
    expect(
      groupByHash([
        { entry, hash: "abcd" },
        { entry, hash: "abcd" },
      ]),
    ).toEqual([]);
  });

  it("returns nothing for no hashed files", () => {
    expect(groupByHash([])).toEqual([]);
  });

  it("refuses a result with no hash", () => {
    expect(() => groupByHash([{ entry: file("a.bin", 1), hash: "" }])).toThrowError(
      /No hash was given/,
    );
  });

  it("refuses a result with no file", () => {
    expect(() =>
      groupByHash([{ entry: undefined as unknown as FsFileEntry, hash: "abcd" }]),
    ).toThrowError(/without the file it belongs to/);
  });
});

/* ------------------------------------------------------------------ *
 * step 4: keep strategies
 * ------------------------------------------------------------------ */

describe("chooseKeeper", () => {
  const files = [
    file("z-root.jpg", 100, 3000),
    file("archive/2019/old/deep-copy.jpg", 100, 1000),
    file("backup/mid.jpg", 100, 5000),
  ];
  const g = group("ffff", 100, files);

  it("first-alpha keeps the first path alphabetically", () => {
    expect(chooseKeeper(g, "first-alpha").path).toBe("archive/2019/old/deep-copy.jpg");
  });

  it("shortest-path keeps the shortest path string", () => {
    expect(chooseKeeper(g, "shortest-path").path).toBe("z-root.jpg");
  });

  it("newest keeps the most recently modified file", () => {
    expect(chooseKeeper(g, "newest").path).toBe("backup/mid.jpg");
  });

  it("oldest keeps the least recently modified file", () => {
    expect(chooseKeeper(g, "oldest").path).toBe("archive/2019/old/deep-copy.jpg");
  });

  it("shallowest keeps the file closest to the top folder", () => {
    expect(chooseKeeper(g, "shallowest").path).toBe("z-root.jpg");
  });

  it("breaks ties by path so the answer never depends on arrival order", () => {
    const tied = group("ffff", 10, [
      file("b/two.txt", 10, 4242),
      file("a/one.txt", 10, 4242),
      file("c/three.txt", 10, 4242),
    ]);
    // Equal timestamps and equal depths: path order decides, both ways round.
    expect(chooseKeeper(tied, "newest").path).toBe("a/one.txt");
    expect(chooseKeeper(tied, "oldest").path).toBe("a/one.txt");
    expect(chooseKeeper(tied, "shallowest").path).toBe("a/one.txt");
  });

  it("refuses a group of one", () => {
    expect(() => chooseKeeper(group("ffff", 10, [file("only.txt", 10)]), "newest")).toThrowError(
      /at least two files/,
    );
  });

  it("refuses a strategy it does not have", () => {
    expect(() => chooseKeeper(g, "largest" as unknown as "newest")).toThrowError(
      /not a way of choosing/,
    );
  });
});

describe("chooseDeletions", () => {
  const files = [
    file("photos/keep.jpg", 4000, 5000),
    file("backup/dupe-a.jpg", 4000, 3000),
    file("backup/dupe-b.jpg", 4000, 1000),
  ];
  const g = group("ffff", 4000, files);

  it("never proposes deleting the file it kept", () => {
    for (const strategy of [
      "first-alpha",
      "shortest-path",
      "newest",
      "oldest",
      "shallowest",
    ] as const) {
      const keeper = chooseKeeper(g, strategy);
      const ops = chooseDeletions(g, strategy);
      expect(ops).toHaveLength(2);
      expect(ops.every((op) => op.op === "delete")).toBe(true);
      expect(ops.map((op) => (op.op === "delete" ? op.path : ""))).not.toContain(keeper.path);
    }
  });

  it("deletes every copy but one", () => {
    expect(chooseDeletions(g, "newest")).toEqual([
      { op: "delete", path: "backup/dupe-a.jpg" },
      { op: "delete", path: "backup/dupe-b.jpg" },
    ]);
  });

  it("planDeletions skips the zero byte group, which frees nothing", () => {
    const groups: DuplicateGroup[] = [
      group("ffff", 4000, files),
      {
        hash: EMPTY_FILE_HASH,
        size: 0,
        files: [file("a/empty.txt", 0), file("b/empty.txt", 0)],
        wastedBytes: 0,
        note: "empty",
      },
    ];
    const ops = planDeletions(groups, "newest");
    expect(ops).toHaveLength(2);
    expect(ops.map((op) => (op.op === "delete" ? op.path : ""))).not.toContain("a/empty.txt");
  });

  it("plans nothing when there are no groups", () => {
    expect(planDeletions([], "newest")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * step 5: summary
 * ------------------------------------------------------------------ */

describe("summarize", () => {
  it("adds up groups, duplicate files and reclaimable space", () => {
    const groups = [
      group("aaaa", 1024 * 1024, [
        file("a/one.bin", 1024 * 1024),
        file("b/one.bin", 1024 * 1024),
        file("c/one.bin", 1024 * 1024),
      ]),
      group("bbbb", 512, [file("a/two.bin", 512), file("b/two.bin", 512)]),
    ];

    const s = summarize(groups);

    expect(s.groupCount).toBe(2);
    expect(s.totalFiles).toBe(5);
    expect(s.duplicateFiles).toBe(3);
    expect(s.reclaimableBytes).toBe(2 * 1024 * 1024 + 512);
    expect(s.reclaimableHuman).toBe("2.0 MB");
    expect(s.largest[0]?.hash).toBe("aaaa");
  });

  it("handles a folder with no duplicates cleanly", () => {
    const s = summarize([]);
    expect(s).toMatchObject({
      groupCount: 0,
      totalFiles: 0,
      duplicateFiles: 0,
      reclaimableBytes: 0,
      reclaimableHuman: "0 B",
    });
    expect(s.largest).toEqual([]);
  });

  it("ignores the zero byte group, because deleting empty files reclaims nothing", () => {
    const s = summarize([
      {
        hash: EMPTY_FILE_HASH,
        size: 0,
        files: [file("a.txt", 0), file("b.txt", 0)],
        wastedBytes: 0,
      },
    ]);
    expect(s.groupCount).toBe(0);
    expect(s.reclaimableBytes).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * odds and ends
 * ------------------------------------------------------------------ */

describe("humanBytes", () => {
  it("formats bytes the way a file manager does", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(999)).toBe("999 B");
    expect(humanBytes(1024)).toBe("1.0 KB");
    expect(humanBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
    expect(humanBytes(1024 * 1024 * 1024 * 42)).toBe("42 GB");
  });
});

describe("run", () => {
  it("returns the usage rows, because the folder only exists in the panel", () => {
    const rows = run("", {});
    expect(rows["How this works"]).toContain("compares sizes");
    expect(rows.Privacy).toContain("your files and inputs never leave your device");
  });
});
