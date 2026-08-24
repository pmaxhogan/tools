import { describe, expect, it } from "vitest";
import type { FsFileEntry, FsScan } from "@/lib/fs-access";
import { ToolError } from "../types";
import {
  applyCase,
  cleanName,
  dateToken,
  globToRegExp,
  planRenames,
  run,
  sanitizeFileName,
  splitName,
  type BulkRenameOpts,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Fixed UTC instants, so no assertion below depends on a timezone. */
const JAN = Date.UTC(2024, 0, 15, 12, 0, 0);
const FEB = Date.UTC(2024, 1, 20, 12, 0, 0);
const MAR = Date.UTC(2024, 2, 25, 12, 0, 0);

function file(path: string, extra: Partial<FsFileEntry> = {}): FsFileEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { kind: "file", name, path, size: 1024, lastModified: JAN, ...extra };
}

function scanOf(entries: FsFileEntry[], directories: string[] = []): FsScan {
  return {
    rootName: "photos",
    entries,
    directories: directories.map((path) => ({
      kind: "directory",
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
    })),
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    fileCount: entries.length,
    truncated: false,
    depthCapped: false,
  };
}

function plan(scan: FsScan, opts: Partial<BulkRenameOpts>) {
  return planRenames(scan, opts);
}

/** Just the renames, as "from -> to" strings, in the order they will run. */
function opLines(result: { ops: { op: string }[] }): string[] {
  return (result.ops as { op: string; from: string; to: string }[]).map(
    (op) => `${op.from} -> ${op.to}`,
  );
}

function rowFor(result: ReturnType<typeof planRenames>, from: string) {
  const row = result.preview.find((entry) => entry.from === from);
  if (!row) throw new Error(`no preview row for ${from}`);
  return row;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

describe("helpers", () => {
  it("splits a filename into base and extension", () => {
    expect(splitName("report.final.pdf")).toEqual({ base: "report.final", ext: ".pdf" });
    expect(splitName("README")).toEqual({ base: "README", ext: "" });
    expect(splitName(".gitignore")).toEqual({ base: ".gitignore", ext: "" });
  });

  it("renders a date token in UTC", () => {
    expect(dateToken(JAN)).toBe("2024-01-15");
    expect(dateToken(0)).toBe("");
  });

  it("turns globs into anchored patterns", () => {
    expect(globToRegExp("*.jpg").test("beach.JPG")).toBe(true);
    expect(globToRegExp("*.jpg").test("beach.jpeg")).toBe(false);
    expect(globToRegExp("IMG_?.png").test("IMG_4.png")).toBe(true);
    expect(globToRegExp("raw/**/*.dng").test("raw/2024/a.dng")).toBe(true);
  });

  it("applies every case mode", () => {
    expect(applyCase("My Photo File", "lower")).toBe("my photo file");
    expect(applyCase("My Photo File", "upper")).toBe("MY PHOTO FILE");
    expect(applyCase("my photo file", "title")).toBe("My Photo File");
    expect(applyCase("MY PHOTO FILE", "title")).toBe("My Photo File");
    expect(applyCase("My Photo File", "kebab")).toBe("my-photo-file");
    expect(applyCase("My Photo File", "snake")).toBe("my_photo_file");
    expect(applyCase("my photo file", "camel")).toBe("myPhotoFile");
    expect(applyCase("some_snake_name", "camel")).toBe("someSnakeName");
    expect(applyCase("alreadyCamelCase", "kebab")).toBe("already-camel-case");
  });

  it("slugifies with the chosen separator", () => {
    expect(cleanName("Cafe Unicode  file", "dash", true)).toBe("cafe-unicode-file");
    expect(cleanName("Cafe Unicode  file", "underscore", false)).toBe("Cafe_Unicode_file");
    expect(cleanName("Cafe Unicode  file", "none", true)).toBe("cafeunicodefile");
  });
});

/* ------------------------------------------------------------------ */
/* filename safety                                                     */
/* ------------------------------------------------------------------ */

describe("sanitizeFileName", () => {
  it("replaces characters Windows refuses", () => {
    const result = sanitizeFileName('a:b*c?d"e<f>g|h/i\\j.txt');
    expect(result.name).toBe("a_b_c_d_e_f_g_h_i_j.txt");
    expect(result.warnings).toHaveLength(1);
  });

  it("drops trailing dots and spaces", () => {
    const result = sanitizeFileName("notes...  ");
    expect(result.name).toBe("notes");
    expect(result.warnings.join(" ")).toContain("Trailing dots");
  });

  it("guards reserved device names", () => {
    expect(sanitizeFileName("CON.txt").name).toBe("_CON.txt");
    expect(sanitizeFileName("com1").name).toBe("_com1");
    expect(sanitizeFileName("lpt9.log").warnings.join(" ")).toContain("reserves");
    expect(sanitizeFileName("console.txt").name).toBe("console.txt");
  });
});

/* ------------------------------------------------------------------ */
/* find and replace                                                    */
/* ------------------------------------------------------------------ */

describe("planRenames: find and replace", () => {
  it("replaces literal text and leaves the extension alone", () => {
    const result = plan(scanOf([file("DSC_0001.jpg"), file("DSC_0002.jpg")]), {
      mode: "find-replace",
      find: "DSC_",
      replace: "beach-",
    });
    expect(opLines(result)).toEqual([
      "DSC_0001.jpg -> beach-0001.jpg",
      "DSC_0002.jpg -> beach-0002.jpg",
    ]);
    expect(result.collisions).toEqual([]);
  });

  it("supports regex group references", () => {
    const result = plan(scanOf([file("invoice-2024-03.pdf")]), {
      mode: "find-replace",
      find: "(\\d{4})-(\\d{2})",
      replace: "$2-$1",
      regex: true,
    });
    expect(opLines(result)).toEqual(["invoice-2024-03.pdf -> invoice-03-2024.pdf"]);
  });

  it("matches case insensitively when asked", () => {
    const result = plan(scanOf([file("IMG_holiday.png")]), {
      mode: "find-replace",
      find: "img_",
      replace: "photo_",
      caseInsensitive: true,
    });
    expect(opLines(result)).toEqual(["IMG_holiday.png -> photo_holiday.png"]);
  });

  it("treats a literal dollar sign as text, not a group reference", () => {
    const result = plan(scanOf([file("price.txt")]), {
      mode: "find-replace",
      find: "price",
      replace: "$1cost",
    });
    expect(opLines(result)).toEqual(["price.txt -> $1cost.txt"]);
  });

  it("can include the extension in the search", () => {
    const result = plan(scanOf([file("photo.jpeg")]), {
      mode: "find-replace",
      find: ".jpeg",
      replace: ".jpg",
      includeExt: true,
    });
    expect(opLines(result)).toEqual(["photo.jpeg -> photo.jpg"]);
  });

  it("throws a ToolError on an unusable regular expression", () => {
    expect(() =>
      plan(scanOf([file("a.txt")]), {
        mode: "find-replace",
        find: "([a-z",
        replace: "x",
        regex: true,
      }),
    ).toThrowError(ToolError);

    try {
      plan(scanOf([file("a.txt")]), {
        mode: "find-replace",
        find: "([a-z",
        replace: "x",
        regex: true,
      });
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-regex");
      expect((error as ToolError).fix).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ */
/* template                                                           */
/* ------------------------------------------------------------------ */

describe("planRenames: template", () => {
  it("fills {n}, {name}, {ext} and {date}", () => {
    const result = plan(
      scanOf([
        file("holiday.jpg", { lastModified: JAN }),
        file("sunset.jpg", { lastModified: FEB }),
      ]),
      {
        mode: "template",
        template: "{date}_{n}_{name}.{ext}",
        seqStart: 1,
        seqPad: 3,
        includeExt: true,
      },
    );
    expect(opLines(result)).toEqual([
      "holiday.jpg -> 2024-01-15_001_holiday.jpg",
      "sunset.jpg -> 2024-02-20_002_sunset.jpg",
    ]);
  });

  it("honors the sequence start and padding width", () => {
    const result = plan(scanOf([file("a.txt"), file("b.txt")]), {
      mode: "template",
      template: "{n}-{name}",
      seqStart: 10,
      seqPad: 4,
    });
    expect(opLines(result)).toEqual(["a.txt -> 0010-a.txt", "b.txt -> 0011-b.txt"]);
  });

  it("keeps a per extension counter separate from {n}", () => {
    const result = plan(scanOf([file("a.jpg"), file("b.png"), file("c.jpg"), file("d.png")]), {
      mode: "template",
      template: "{ext}-{counter}-of-{n}",
      seqPad: 1,
    });
    expect(opLines(result)).toEqual([
      "a.jpg -> jpg-1-of-1.jpg",
      "b.png -> png-1-of-2.png",
      "c.jpg -> jpg-2-of-3.jpg",
      "d.png -> png-2-of-4.png",
    ]);
  });

  it("uses the containing folder for {parent} and the root at the top level", () => {
    const result = plan(scanOf([file("vacation/a.jpg"), file("b.jpg")], ["vacation"]), {
      mode: "template",
      template: "{parent}-{name}",
    });
    // Sorted by filename, so "a.jpg" inside the subfolder comes first.
    expect(opLines(result)).toEqual([
      "vacation/a.jpg -> vacation/vacation-a.jpg",
      "b.jpg -> photos-b.jpg",
    ]);
  });

  it("never lets a template move a file into another folder", () => {
    const result = plan(scanOf([file("a.txt")]), {
      mode: "template",
      template: "../escaped/{name}",
    });
    expect(opLines(result)).toEqual(["a.txt -> .._escaped_a.txt"]);
    expect(rowFor(result, "a.txt").warning).toContain("Windows does not allow");
  });
});

/* ------------------------------------------------------------------ */
/* case, sequence, clean                                               */
/* ------------------------------------------------------------------ */

describe("planRenames: case mode", () => {
  it("lowercases through a temporary name, because case only renames need one", () => {
    const result = plan(scanOf([file("Beach Photo.JPG")]), {
      mode: "case",
      caseMode: "lower",
    });
    expect(rowFor(result, "Beach Photo.JPG").to).toBe("beach photo.JPG");
    expect(opLines(result)).toEqual([
      "Beach Photo.JPG -> beach photo.JPG.renaming-tmp",
      "beach photo.JPG.renaming-tmp -> beach photo.JPG",
    ]);
  });

  it("title cases the base name only", () => {
    const result = plan(scanOf([file("annual report final.DOCX")]), {
      mode: "case",
      caseMode: "title",
    });
    expect(rowFor(result, "annual report final.DOCX").to).toBe("Annual Report Final.DOCX");
  });

  it("camel cases across separators", () => {
    const result = plan(scanOf([file("my_long file-name.md")]), {
      mode: "case",
      caseMode: "camel",
    });
    expect(opLines(result)).toEqual(["my_long file-name.md -> myLongFileName.md"]);
  });
});

describe("planRenames: sequence mode", () => {
  it("numbers files in the chosen sort order and keeps the extension", () => {
    const result = plan(
      scanOf([
        file("zebra.png", { lastModified: MAR }),
        file("apple.png", { lastModified: FEB }),
        file("mango.png", { lastModified: JAN }),
      ]),
      { mode: "sequence", prefix: "shot-", seqStart: 1, seqPad: 2, sortBy: "date" },
    );
    expect(opLines(result)).toEqual([
      "mango.png -> shot-01.png",
      "apple.png -> shot-02.png",
      "zebra.png -> shot-03.png",
    ]);
  });

  it("numbers by size when asked", () => {
    const result = plan(scanOf([file("big.bin", { size: 900 }), file("small.bin", { size: 10 })]), {
      mode: "sequence",
      prefix: "f",
      seqPad: 1,
      sortBy: "size",
    });
    expect(opLines(result)).toEqual(["small.bin -> f1.bin", "big.bin -> f2.bin"]);
  });
});

describe("planRenames: clean mode", () => {
  it("strips diacritics, tidies spaces and drops awkward characters", () => {
    const result = plan(scanOf([file("Café Ünïcode  (final)!.TXT")]), {
      mode: "clean",
      separator: "dash",
      lowercase: true,
    });
    expect(opLines(result)).toEqual(["Café Ünïcode  (final)!.TXT -> cafe-unicode-final.TXT"]);
  });
});

/* ------------------------------------------------------------------ */
/* filtering                                                           */
/* ------------------------------------------------------------------ */

describe("planRenames: filtering", () => {
  it("targets only the files a glob matches", () => {
    const result = plan(
      scanOf([file("a.jpg"), file("b.png"), file("notes.txt"), file("raw/c.jpg")]),
      { mode: "template", template: "x-{name}", filterMode: "glob", filter: "*.jpg" },
    );
    expect(opLines(result)).toEqual(["a.jpg -> x-a.jpg", "raw/c.jpg -> raw/x-c.jpg"]);
    expect(result.preview).toHaveLength(4);
    expect(rowFor(result, "b.png").changed).toBe(false);
    expect(rowFor(result, "b.png").to).toBe("b.png");
  });

  it("targets only the files a regex filter matches", () => {
    const result = plan(scanOf([file("IMG_1.jpg"), file("scan_1.jpg")]), {
      mode: "find-replace",
      find: "_",
      replace: "-",
      filterMode: "regex",
      filter: "^IMG_",
    });
    expect(opLines(result)).toEqual(["IMG_1.jpg -> IMG-1.jpg"]);
  });

  it("throws a ToolError on an unusable filter expression", () => {
    try {
      plan(scanOf([file("a.txt")]), { filterMode: "regex", filter: "(" });
      throw new Error("expected a ToolError");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("bad-filter");
    }
  });
});

/* ------------------------------------------------------------------ */
/* collisions and ordering                                             */
/* ------------------------------------------------------------------ */

describe("planRenames: collisions", () => {
  it("blocks two files aiming at the same name", () => {
    const clash = plan(scanOf([file("a-1.txt"), file("a-2.txt")]), {
      mode: "find-replace",
      find: "\\d",
      replace: "",
      regex: true,
    });
    expect(clash.ops).toEqual([]);
    expect(clash.collisions).toHaveLength(1);
    expect(clash.collisions[0]).toContain("a-.txt");
    expect(rowFor(clash, "a-1.txt").to).toBe("a-.txt");
    expect(rowFor(clash, "a-1.txt").changed).toBe(false);
    expect(rowFor(clash, "a-1.txt").warning).toContain("held back");
  });

  it("blocks a rename onto an existing file that is not moving", () => {
    const result = plan(scanOf([file("draft.txt"), file("final.txt")]), {
      mode: "find-replace",
      find: "draft",
      replace: "final",
    });
    expect(result.ops).toEqual([]);
    expect(result.collisions[0]).toContain("already exists");
    expect(rowFor(result, "draft.txt").to).toBe("final.txt");
    expect(rowFor(result, "draft.txt").changed).toBe(false);
  });

  it("blocks a rename onto an existing folder name", () => {
    const result = plan(scanOf([file("archive.txt")], ["archive"]), {
      mode: "find-replace",
      find: ".txt",
      replace: "",
      includeExt: true,
    });
    expect(result.ops).toEqual([]);
    expect(result.collisions[0]).toContain("already exists");
  });

  it("orders a shifting run so every target is free when it runs", () => {
    const result = plan(scanOf([file("img-001.jpg"), file("img-002.jpg"), file("img-003.jpg")]), {
      mode: "sequence",
      prefix: "img-",
      seqStart: 0,
      seqPad: 3,
    });
    expect(result.collisions).toEqual([]);
    expect(opLines(result)).toEqual([
      "img-001.jpg -> img-000.jpg",
      "img-002.jpg -> img-001.jpg",
      "img-003.jpg -> img-002.jpg",
    ]);
  });

  it("orders a run shifting the other way too", () => {
    const result = plan(scanOf([file("a1.txt"), file("a2.txt")]), {
      mode: "sequence",
      prefix: "a",
      seqStart: 2,
      seqPad: 1,
    });
    expect(result.collisions).toEqual([]);
    expect(opLines(result)).toEqual(["a2.txt -> a3.txt", "a1.txt -> a2.txt"]);
  });

  it("cascades a block back down the chain that depended on it", () => {
    // a2 -> a3 is blocked by the untouched a3, which leaves a1 -> a2 with
    // nowhere to go either. Neither op is emitted.
    const result = plan(scanOf([file("a1.txt"), file("a2.txt"), file("a3.txt")]), {
      mode: "sequence",
      prefix: "a",
      seqStart: 2,
      seqPad: 1,
      filterMode: "regex",
      filter: "^a[12]\\.txt$",
    });
    expect(result.ops).toEqual([]);
    expect(result.collisions).toHaveLength(2);
    expect(rowFor(result, "a1.txt").changed).toBe(false);
    expect(rowFor(result, "a2.txt").changed).toBe(false);
  });

  it("blocks a case only rename when both spellings already exist", () => {
    // Legal on Linux, so the scan really can hold both. Renaming one onto the
    // other is still an overwrite, and an overwrite never happens.
    const result = plan(scanOf([file("A.txt"), file("a.txt")]), {
      mode: "case",
      caseMode: "lower",
    });
    expect(result.ops).toEqual([]);
    expect(result.collisions[0]).toContain("already exists");
  });

  it("reports a pair that would swap names instead of failing halfway", () => {
    const result = plan(scanOf([file("ab.txt"), file("ba.txt")]), {
      mode: "find-replace",
      find: "^(.)(.)$",
      replace: "$2$1",
      regex: true,
    });
    expect(result.ops).toEqual([]);
    expect(result.collisions).toHaveLength(2);
    expect(result.collisions[0]).toContain("swap names");
    expect(rowFor(result, "ab.txt").warning).toContain("loop");
  });
});

/* ------------------------------------------------------------------ */
/* everything else                                                     */
/* ------------------------------------------------------------------ */

describe("planRenames: edge cases", () => {
  it("emits nothing for files whose name does not change", () => {
    const result = plan(scanOf([file("already-clean.txt")]), {
      mode: "find-replace",
      find: "nothing-matches",
      replace: "x",
    });
    expect(result.ops).toEqual([]);
    expect(result.preview).toEqual([
      { from: "already-clean.txt", to: "already-clean.txt", changed: false },
    ]);
  });

  it("emits nothing when the find field is empty", () => {
    const result = plan(scanOf([file("a.txt")]), { mode: "find-replace", find: "", replace: "x" });
    expect(result.ops).toEqual([]);
  });

  it("skips a file whose new name would be empty", () => {
    const result = plan(scanOf([file("2024.txt")]), {
      mode: "find-replace",
      find: "\\d",
      replace: "",
      regex: true,
    });
    expect(result.ops).toEqual([]);
    const row = rowFor(result, "2024.txt");
    expect(row.to).toBe("2024.txt");
    expect(row.warning).toContain("empty");
  });

  it("warns and sanitizes a name with characters Windows refuses", () => {
    const result = plan(scanOf([file("report.txt")]), {
      mode: "find-replace",
      find: "report",
      replace: "q3:report",
    });
    expect(opLines(result)).toEqual(["report.txt -> q3_report.txt"]);
    expect(rowFor(result, "report.txt").warning).toContain("Windows does not allow");
  });

  it("warns when the new name is a reserved device name", () => {
    const result = plan(scanOf([file("notes.txt")]), {
      mode: "find-replace",
      find: "notes",
      replace: "aux",
    });
    expect(opLines(result)).toEqual(["notes.txt -> _aux.txt"]);
    expect(rowFor(result, "notes.txt").warning).toContain("reserves");
  });

  it("warns when an existing file differs only in capitalization", () => {
    const result = plan(scanOf([file("notes.txt"), file("README.md")]), {
      mode: "find-replace",
      find: "notes",
      replace: "readme",
      includeExt: false,
    });
    expect(rowFor(result, "notes.txt").to).toBe("readme.txt");
    // Different extension, so no clash at all.
    expect(rowFor(result, "notes.txt").warning).toBeUndefined();

    const clash = plan(scanOf([file("notes.md"), file("README.md")]), {
      mode: "find-replace",
      find: "notes",
      replace: "readme",
    });
    expect(rowFor(clash, "notes.md").warning).toContain("different capitalization");
  });

  it("handles an empty folder", () => {
    const result = plan(scanOf([]), { mode: "sequence", prefix: "x" });
    expect(result).toEqual({ ops: [], preview: [], collisions: [] });
  });

  it("rejects a mode it does not know", () => {
    try {
      plan(scanOf([file("a.txt")]), { mode: "sideways" as never });
      throw new Error("expected a ToolError");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("unknown-mode");
    }
  });
});

describe("run", () => {
  it("returns the usage rows, because this tool is panel first", () => {
    const rows = run();
    expect(Object.keys(rows)).toContain("How this works");
    expect(rows.Privacy ?? "").toContain("your files and inputs never leave your device");
  });
});
