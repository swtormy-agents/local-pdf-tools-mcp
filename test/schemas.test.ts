import { describe, expect, it } from "vitest";
import { z } from "zod";
import { imagesToPdfSchema, organizeArgsError, pdfMergeSchema, pdfOrganizeSchema, pdfSplitSchema, splitArgsError } from "../src/schemas";

const obj = (s: Record<string, z.ZodTypeAny>) => z.object(s);

describe("schemas", () => {
  it("pdf_merge needs at least two inputs", () => {
    expect(obj(pdfMergeSchema).safeParse({ inputs: ["a.pdf"], outputDir: "out" }).success).toBe(false);
    expect(obj(pdfMergeSchema).safeParse({ inputs: ["a.pdf", "b.pdf"], outputDir: "out" }).success).toBe(true);
  });
  it("pdf_split validates ranges and page numbers", () => {
    const s = obj(pdfSplitSchema);
    expect(s.safeParse({ input: "a.pdf", mode: "ranges", ranges: [{ from: 3, to: 1 }], outputDir: "o" }).success).toBe(false);
    expect(s.safeParse({ input: "a.pdf", mode: "extract", pages: [0], outputDir: "o" }).success).toBe(false);
    expect(s.safeParse({ input: "a.pdf", mode: "every_n", n: 2, outputDir: "o" }).success).toBe(true);
    expect(splitArgsError({ mode: "ranges" })).toMatch(/needs ranges/);
    expect(splitArgsError({ mode: "every_n", n: 2 })).toBeNull();
  });
  it("pdf_organize: 1-based order, rotate as {page, degrees} with multiples of 90, optional delete", () => {
    const s = obj(pdfOrganizeSchema);
    expect(s.safeParse({ input: "a.pdf", order: [3, 1, 2], outputDir: "o" }).success).toBe(true);
    expect(s.safeParse({ input: "a.pdf", order: [0, 1], outputDir: "o" }).success).toBe(false);
    expect(s.safeParse({ input: "a.pdf", order: [], outputDir: "o" }).success).toBe(false);
    expect(s.safeParse({ input: "a.pdf", order: [1], rotate: [{ page: 1, degrees: 45 }], outputDir: "o" }).success).toBe(false);
    expect(s.safeParse({ input: "a.pdf", order: [1], rotate: [{ page: 0, degrees: 90 }], outputDir: "o" }).success).toBe(false);
    for (const degrees of [90, 180, 270, 360, -90]) {
      expect(s.safeParse({ input: "a.pdf", order: [1], rotate: [{ page: 1, degrees }], outputDir: "o" }).success, String(degrees)).toBe(true);
    }
    expect(s.safeParse({ input: "a.pdf", rotate: { "2": 90 }, outputDir: "o" }).success).toBe(false);
    expect(s.safeParse({ input: "a.pdf", delete: [2], outputDir: "o" }).success).toBe(true);
  });
  it("pdf_organize cross-field rules", () => {
    expect(organizeArgsError({})).toMatch(/Give order/);
    expect(organizeArgsError({ order: [1], delete: [2] })).toMatch(/not both/);
    expect(organizeArgsError({ order: [1], rotate: [{ page: 1 }, { page: 1 }] })).toMatch(/more than once/);
    expect(organizeArgsError({ order: [2, 1] })).toBeNull();
    expect(organizeArgsError({ delete: [2] })).toBeNull();
    expect(organizeArgsError({ rotate: [{ page: 1 }] })).toBeNull();
  });
  it("images_to_pdf defaults and bounds", () => {
    const r = obj(imagesToPdfSchema).parse({ images: ["a.jpg"], outputDir: "o" });
    expect(r.pageSize).toBe("a4");
    expect(r.marginMm).toBe(0);
    expect(obj(imagesToPdfSchema).safeParse({ images: ["a.jpg"], outputDir: "o", marginMm: 100 }).success).toBe(false);
  });
});
