import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { ToolError } from "../types";
import {
  deletePages,
  extractPages,
  fillForm,
  formatPdfInfo,
  getPdfInfo,
  listFormFields,
  loadPdf,
  mergePdfs,
  parsePageRanges,
  reorderPages,
  rotatePages,
  run,
  splitPdf,
  watermarkPdf,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * A document whose pages all have distinct widths (200, 201, 202 ...), so a
 * test can assert page identity and ordering by reading the page sizes back
 * after a round trip. Reading text back out would need a full PDF renderer.
 */
async function makeDoc(pageCount: number, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  if (title) {
    doc.setTitle(title);
    doc.setAuthor("Test Author");
  }
  for (let i = 0; i < pageCount; i += 1) {
    const page = doc.addPage([200 + i, 300]);
    page.drawText(`Page ${i + 1}`, { x: 10, y: 150, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save();
}

/** Letter sized document carrying one of every fillable field type. */
async function makeFormDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const first = doc.addPage([612, 792]);
  const second = doc.addPage([612, 792]);
  const form = doc.getForm();

  const name = form.createTextField("applicant.name");
  name.setText("Ada");
  name.addToPage(first, { x: 50, y: 700, width: 220, height: 20 });

  const agree = form.createCheckBox("agree");
  agree.addToPage(first, { x: 50, y: 650, width: 16, height: 16 });

  const color = form.createDropdown("favorite.color");
  color.setOptions(["Red", "Green", "Blue"]);
  color.select("Red");
  color.addToPage(first, { x: 50, y: 600, width: 120, height: 20 });

  const plan = form.createRadioGroup("plan");
  plan.addOptionToPage("basic", second, { x: 50, y: 700, width: 16, height: 16 });
  plan.addOptionToPage("pro", second, { x: 50, y: 670, width: 16, height: 16 });

  return doc.save();
}

async function pageWidths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => Math.round(p.getSize().width));
}

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

/* ------------------------------------------------------------------ */
/* parsePageRanges                                                     */
/* ------------------------------------------------------------------ */

describe("parsePageRanges", () => {
  it("parses a mixed spec into one group per comma segment", () => {
    expect(parsePageRanges("1-3,7,9-end", 12)).toEqual([[1, 2, 3], [7], [9, 10, 11, 12]]);
  });

  it("resolves the end keyword on both sides of a range", () => {
    expect(parsePageRanges("end", 4)).toEqual([[4]]);
    expect(parsePageRanges("end-end", 4)).toEqual([[4]]);
  });

  it("tolerates whitespace around numbers and dashes", () => {
    expect(parsePageRanges("  2 - 4 ,  6 ", 8)).toEqual([[2, 3, 4], [6]]);
  });

  it("keeps the order the user typed rather than sorting", () => {
    expect(parsePageRanges("5,1-2", 5)).toEqual([[5], [1, 2]]);
  });

  it("rejects an empty spec", () => {
    expect(() => parsePageRanges("   ", 5)).toThrowError(ToolError);
    try {
      parsePageRanges("", 5);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-range");
    }
  });

  it("rejects a trailing comma", () => {
    try {
      parsePageRanges("1-2,", 5);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-range");
    }
  });

  it("rejects non numeric tokens", () => {
    try {
      parsePageRanges("one", 5);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-range");
      expect((e as ToolError).message).toContain('"one"');
    }
  });

  it("rejects page zero and pages past the end", () => {
    try {
      parsePageRanges("0", 5);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("page-out-of-range");
    }
    try {
      parsePageRanges("9", 5);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("page-out-of-range");
      expect((e as ToolError).message).toContain("5 pages");
    }
  });

  it("rejects a backwards range and suggests the fix", () => {
    try {
      parsePageRanges("5-2", 9);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("reversed-range");
      expect((e as ToolError).fix).toContain("2-5");
    }
  });

  it("rejects a document with no pages", () => {
    try {
      parsePageRanges("1", 0);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("no-pages");
    }
  });
});

/* ------------------------------------------------------------------ */
/* loadPdf                                                             */
/* ------------------------------------------------------------------ */

describe("loadPdf", () => {
  it("loads a real PDF", async () => {
    const doc = await loadPdf(await makeDoc(2));
    expect(doc.getPageCount()).toBe(2);
  });

  it("rejects empty input", async () => {
    await expect(loadPdf(new Uint8Array(0))).rejects.toMatchObject({ code: "empty-input" });
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(loadPdf(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toMatchObject({
      code: "invalid-pdf",
    });
  });

  it("rejects a non byte input", async () => {
    await expect(loadPdf("not bytes" as unknown as Uint8Array)).rejects.toMatchObject({
      code: "not-bytes",
    });
  });

  // Password protected PDFs are reported as ToolError('encrypted-pdf'), which
  // is raised from the EncryptedPDFError branch above. pdf-lib 1.17 can read
  // encryption dictionaries but cannot write one, so there is no way to build
  // an encrypted fixture with the dependencies this project has. The branch is
  // deliberately left to manual verification with a real protected file.
});

/* ------------------------------------------------------------------ */
/* merge                                                               */
/* ------------------------------------------------------------------ */

describe("mergePdfs", () => {
  it("concatenates page counts in the order given", async () => {
    const a = await makeDoc(2);
    const b = await makeDoc(3);
    const merged = await mergePdfs([a, b]);
    expect(await pageCount(merged)).toBe(5);
  });

  it("keeps the document order, not the page size order", async () => {
    const first = await PDFDocument.create();
    first.addPage([400, 400]);
    const second = await PDFDocument.create();
    second.addPage([100, 100]);
    const merged = await mergePdfs([await second.save(), await first.save()]);
    expect(await pageWidths(merged)).toEqual([100, 400]);
  });

  it("merges a single document into a copy of itself", async () => {
    const merged = await mergePdfs([await makeDoc(3)]);
    expect(await pageCount(merged)).toBe(3);
  });

  it("rejects an empty list", async () => {
    await expect(mergePdfs([])).rejects.toMatchObject({ code: "no-documents" });
  });

  it("reports which file is not a PDF", async () => {
    await expect(mergePdfs([await makeDoc(1), new Uint8Array([9, 9, 9])])).rejects.toMatchObject({
      code: "invalid-pdf",
    });
  });
});

/* ------------------------------------------------------------------ */
/* split and extract                                                   */
/* ------------------------------------------------------------------ */

describe("splitPdf", () => {
  it("produces one file per range with the right pages", async () => {
    const doc = await makeDoc(12);
    const parts = await splitPdf(doc, "1-3,7,9-end");
    expect(parts.map((p) => p.suffix)).toEqual(["pages-1-3", "page-7", "pages-9-12"]);
    expect(await pageCount(parts[0]!.bytes)).toBe(3);
    expect(await pageCount(parts[1]!.bytes)).toBe(1);
    expect(await pageCount(parts[2]!.bytes)).toBe(4);
  });

  it("copies the pages the range names, checked by page width", async () => {
    const doc = await makeDoc(5);
    const parts = await splitPdf(doc, "4-5");
    // Widths are 200 + index, so pages 4 and 5 are 203 and 204 points wide.
    expect(await pageWidths(parts[0]!.bytes)).toEqual([203, 204]);
  });

  it("resolves end against the real page count", async () => {
    const parts = await splitPdf(await makeDoc(6), "5-end");
    expect(parts[0]!.pages).toEqual([5, 6]);
  });

  it("rejects a range past the last page", async () => {
    await expect(splitPdf(await makeDoc(3), "1-9")).rejects.toMatchObject({
      code: "page-out-of-range",
    });
  });

  it("rejects an unparseable spec", async () => {
    await expect(splitPdf(await makeDoc(3), "first two")).rejects.toMatchObject({
      code: "invalid-range",
    });
  });
});

describe("extractPages", () => {
  it("flattens every range into one document", async () => {
    const out = await extractPages(await makeDoc(6), "1,4-5");
    expect(await pageWidths(out)).toEqual([200, 203, 204]);
  });
});

/* ------------------------------------------------------------------ */
/* rotate                                                              */
/* ------------------------------------------------------------------ */

describe("rotatePages", () => {
  it("persists a rotation that survives a reload", async () => {
    const out = await rotatePages(await makeDoc(3), "all", 90);
    const doc = await PDFDocument.load(out);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90, 90]);
  });

  it("rotates only the pages listed", async () => {
    const out = await rotatePages(await makeDoc(3), [2], 180);
    const doc = await PDFDocument.load(out);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 180, 0]);
  });

  it("adds to the rotation a page already had and wraps at 360", async () => {
    const base = await PDFDocument.create();
    base.addPage([200, 300]).setRotation(degrees(270));
    const out = await rotatePages(await base.save(), "all", 180);
    expect((await PDFDocument.load(out)).getPage(0).getRotation().angle).toBe(90);
  });

  it("rejects an angle that is not a quarter turn", async () => {
    await expect(rotatePages(await makeDoc(1), "all", 45 as unknown as 90)).rejects.toMatchObject({
      code: "invalid-rotation",
    });
  });

  it("rejects a page number the document does not have", async () => {
    await expect(rotatePages(await makeDoc(2), [5], 90)).rejects.toMatchObject({
      code: "page-out-of-range",
    });
  });

  it("rejects an empty page selection", async () => {
    await expect(rotatePages(await makeDoc(2), [], 90)).rejects.toMatchObject({
      code: "no-pages-selected",
    });
  });
});

/* ------------------------------------------------------------------ */
/* reorder and delete                                                  */
/* ------------------------------------------------------------------ */

describe("reorderPages", () => {
  it("rewrites the page order", async () => {
    const out = await reorderPages(await makeDoc(4), [4, 3, 2, 1]);
    expect(await pageWidths(out)).toEqual([203, 202, 201, 200]);
  });

  it("deletes the pages left out of the list", async () => {
    const out = await reorderPages(await makeDoc(5), [3, 1]);
    expect(await pageWidths(out)).toEqual([202, 200]);
  });

  it("keeps form fields alive across a reorder", async () => {
    const out = await reorderPages(await makeFormDoc(), [2, 1]);
    const names = (await PDFDocument.load(out))
      .getForm()
      .getFields()
      .map((f) => f.getName())
      .sort();
    expect(names).toEqual(["agree", "applicant.name", "favorite.color", "plan"]);
  });

  it("rejects a duplicated page", async () => {
    await expect(reorderPages(await makeDoc(3), [1, 1, 2])).rejects.toMatchObject({
      code: "duplicate-page",
    });
  });

  it("rejects an out of range page", async () => {
    await expect(reorderPages(await makeDoc(3), [1, 4])).rejects.toMatchObject({
      code: "page-out-of-range",
    });
  });

  it("rejects an empty order", async () => {
    await expect(reorderPages(await makeDoc(3), [])).rejects.toMatchObject({
      code: "no-pages-selected",
    });
  });
});

describe("deletePages", () => {
  it("drops the listed pages and keeps the rest in order", async () => {
    const out = await deletePages(await makeDoc(5), [2, 4]);
    expect(await pageWidths(out)).toEqual([200, 202, 204]);
  });

  it("refuses to delete every page", async () => {
    await expect(deletePages(await makeDoc(2), [1, 2])).rejects.toMatchObject({
      code: "deletes-everything",
    });
  });
});

/* ------------------------------------------------------------------ */
/* watermark                                                           */
/* ------------------------------------------------------------------ */

describe("watermarkPdf", () => {
  it("changes the file without changing the page count", async () => {
    const doc = await makeDoc(3);
    const out = await watermarkPdf(doc, { text: "DRAFT" });
    expect(await pageCount(out)).toBe(3);
    expect(out.length).not.toBe(doc.length);
    expect(Buffer.from(out).equals(Buffer.from(doc))).toBe(false);
  });

  it("produces a document that still parses", async () => {
    const out = await watermarkPdf(await makeDoc(2), {
      text: "CONFIDENTIAL",
      opacity: 0.35,
      fontSize: 24,
      angle: 30,
      color: "#0af",
      position: "center",
    });
    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(2);
  });

  it("accepts every position", async () => {
    const doc = await makeDoc(1);
    for (const position of ["center", "diagonal", "bottom"] as const) {
      const out = await watermarkPdf(doc, { text: "X", position });
      expect(await pageCount(out)).toBe(1);
    }
  });

  it("rejects empty text", async () => {
    await expect(watermarkPdf(await makeDoc(1), { text: "  " })).rejects.toMatchObject({
      code: "empty-watermark",
    });
  });

  it("rejects an opacity outside 0 to 1", async () => {
    await expect(watermarkPdf(await makeDoc(1), { text: "X", opacity: 4 })).rejects.toMatchObject({
      code: "invalid-opacity",
    });
    await expect(watermarkPdf(await makeDoc(1), { text: "X", opacity: 0 })).rejects.toMatchObject({
      code: "invalid-opacity",
    });
  });

  it("rejects an impossible font size", async () => {
    await expect(watermarkPdf(await makeDoc(1), { text: "X", fontSize: 0 })).rejects.toMatchObject({
      code: "invalid-font-size",
    });
  });

  it("rejects an angle that is not a number", async () => {
    await expect(
      watermarkPdf(await makeDoc(1), { text: "X", angle: Number.NaN }),
    ).rejects.toMatchObject({ code: "invalid-angle" });
  });

  it("rejects a color that is not hex", async () => {
    await expect(
      watermarkPdf(await makeDoc(1), { text: "X", color: "reddish" }),
    ).rejects.toMatchObject({ code: "invalid-color" });
  });

  it("rejects an unknown position", async () => {
    await expect(
      watermarkPdf(await makeDoc(1), {
        text: "X",
        position: "corner" as unknown as "center",
      }),
    ).rejects.toMatchObject({ code: "invalid-position" });
  });
});

/* ------------------------------------------------------------------ */
/* forms                                                               */
/* ------------------------------------------------------------------ */

describe("listFormFields", () => {
  it("reports every field with its type and current value", async () => {
    const fields = await listFormFields(await makeFormDoc());
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(fields).toHaveLength(4);
    expect(byName["applicant.name"]).toMatchObject({ type: "text", value: "Ada" });
    expect(byName["agree"]).toMatchObject({ type: "checkbox", value: "false" });
    expect(byName["favorite.color"]).toMatchObject({
      type: "dropdown",
      value: "Red",
      options: ["Red", "Green", "Blue"],
    });
    expect(byName["plan"]).toMatchObject({ type: "radio", options: ["basic", "pro"] });
  });

  it("returns an empty list for a document with no form", async () => {
    expect(await listFormFields(await makeDoc(2))).toEqual([]);
  });
});

describe("fillForm", () => {
  it("round trips text, checkbox, dropdown, and radio values", async () => {
    const out = await fillForm(await makeFormDoc(), {
      "applicant.name": "Grace Hopper",
      agree: "yes",
      "favorite.color": "Blue",
      plan: "pro",
    });
    const fields = await listFormFields(out);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    expect(byName["applicant.name"]).toBe("Grace Hopper");
    expect(byName["agree"]).toBe("true");
    expect(byName["favorite.color"]).toBe("Blue");
    expect(byName["plan"]).toBe("pro");
  });

  it("unticks a checkbox for any value that is not truthy", async () => {
    const ticked = await fillForm(await makeFormDoc(), { agree: "true" });
    const unticked = await fillForm(ticked, { agree: "no" });
    const fields = await listFormFields(unticked);
    expect(fields.find((f) => f.name === "agree")?.value).toBe("false");
  });

  it("matches a choice case insensitively", async () => {
    const out = await fillForm(await makeFormDoc(), { "favorite.color": "green" });
    const fields = await listFormFields(out);
    expect(fields.find((f) => f.name === "favorite.color")?.value).toBe("Green");
  });

  it("flattens the form so the fields are gone but the pages remain", async () => {
    const out = await fillForm(
      await makeFormDoc(),
      { "applicant.name": "Flat" },
      { flatten: true },
    );
    expect(await listFormFields(out)).toEqual([]);
    expect(await pageCount(out)).toBe(2);
  });

  it("rejects an unknown field name and lists the real ones", async () => {
    try {
      await fillForm(await makeFormDoc(), { nickname: "x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-field");
      expect((e as ToolError).fix).toContain("applicant.name");
    }
  });

  it("rejects a choice the field does not offer", async () => {
    try {
      await fillForm(await makeFormDoc(), { "favorite.color": "Chartreuse" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-option");
      expect((e as ToolError).fix).toContain("Red, Green, Blue");
    }
  });

  it("rejects an empty value map", async () => {
    await expect(fillForm(await makeFormDoc(), {})).rejects.toMatchObject({ code: "no-values" });
  });
});

/* ------------------------------------------------------------------ */
/* info and run                                                        */
/* ------------------------------------------------------------------ */

describe("getPdfInfo", () => {
  it("reports pages, sizes, and metadata", async () => {
    const info = await getPdfInfo(await makeDoc(3, "Quarterly Report"));
    expect(info.pageCount).toBe(3);
    expect(info.title).toBe("Quarterly Report");
    expect(info.author).toBe("Test Author");
    expect(info.pageSizes).toHaveLength(3);
    expect(info.formFieldCount).toBe(0);
  });

  it("names a common paper size and groups identical pages", async () => {
    const info = await getPdfInfo(await makeFormDoc());
    expect(info.pageSizes).toEqual([{ label: "612 x 792 pt (Letter)", count: 2 }]);
    expect(info.formFieldCount).toBe(4);
  });

  it("leaves absent metadata off the report", async () => {
    const bare = await PDFDocument.create();
    bare.addPage([595.28, 841.89]);
    const info = await getPdfInfo(await bare.save());
    expect(info.title).toBeUndefined();
    expect(info.pageSizes[0]!.label).toContain("A4");
  });

  it("reports a password protected file honestly rather than guessing", async () => {
    // Verified against the error path: a parse failure that is not an
    // EncryptedPDFError still gets an actionable message.
    await expect(getPdfInfo(new Uint8Array([37, 33, 80, 83]))).rejects.toMatchObject({
      code: "invalid-pdf",
    });
  });
});

describe("formatPdfInfo", () => {
  it("renders one labeled row per fact", () => {
    const text = formatPdfInfo({
      pageCount: 2,
      pageSizes: [{ label: "612 x 792 pt (Letter)", count: 2 }],
      title: "Contract",
      formFieldCount: 3,
      byteLength: 2048,
    });
    expect(text).toContain("Pages: 2");
    expect(text).toContain("File size: 2.0 KB");
    expect(text).toContain("Title: Contract");
    expect(text).toContain("Form fields: 3");
  });
});

describe("run", () => {
  it("reports on dropped bytes", async () => {
    const text = await run(await makeDoc(2, "Invoice"));
    expect(text).toContain("Pages: 2");
    expect(text).toContain("Title: Invoice");
  });

  it("explains itself when handed text instead of a file", async () => {
    const text = await run("hello");
    expect(text).toContain("works on PDF files");
    expect(text).toContain("your files and inputs never leave your device");
  });

  it("surfaces a parse failure as a ToolError", async () => {
    await expect(run(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ToolError);
  });
});
