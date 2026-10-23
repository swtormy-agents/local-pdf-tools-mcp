import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PAGE_SIZES } from "@local-pdf-tools/core";
import { IMAGE_PAGE_SIZES, imageOptions, imagesToPdfSchema, organizeArgsError, pdfMergeSchema, pdfOrganizeSchema, pdfSplitSchema, PT_PER_MM, splitArgsError } from "../src/schemas";

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
    expect(s.safeParse({ input: "a.pdf", order: [1, 1, 2, 1], outputDir: "o" }).success).toBe(true); // repeats allowed
    for (const degrees of [90, 180, 270, 360, -90, -270, 450, 720]) {
      expect(s.safeParse({ input: "a.pdf", order: [1], rotate: [{ page: 1, degrees }], outputDir: "o" }).success, String(degrees)).toBe(true);
    }
    expect(s.safeParse({ input: "a.pdf", rotate: { "2": 90 }, outputDir: "o" }).success).toBe(false);
    expect(s.safeParse({ input: "a.pdf", delete: [2], outputDir: "o" }).success).toBe(true);
  });
  it("pdf_organize cross-field rules", () => {
    expect(organizeArgsError({})).toMatch(/Give order/);
    expect(organizeArgsError({ order: [1], delete: [2] })).toMatch(/not both/);
    expect(organizeArgsError({ order: [1], rotate: [{ page: 1 }, { page: 1 }] })).toBeNull(); // summed by the adapter
    expect(organizeArgsError({ order: [2, 1] })).toBeNull();
    expect(organizeArgsError({ delete: [2] })).toBeNull();
    expect(organizeArgsError({ rotate: [{ page: 1 }] })).toBeNull();
  });
  it("images_to_pdf: pageSize from the core's PAGE_SIZES (default fit), marginMm 0-50 (default 0)", () => {
    const o = obj(imagesToPdfSchema);
    expect(IMAGE_PAGE_SIZES).toEqual(["fit", ...Object.keys(PAGE_SIZES)]);
    expect(IMAGE_PAGE_SIZES).toEqual(["fit", "A4", "Letter"]);
    expect(o.parse({ images: ["a.jpg"], outputDir: "o" })).toEqual({ images: ["a.jpg"], outputDir: "o", pageSize: "fit", marginMm: 0 });
    expect(o.parse({ images: ["a.jpg"], outputDir: "o", pageSize: "Letter", marginMm: 12.5 }).pageSize).toBe("Letter");
    for (const bad of [{ pageSize: "a4" }, { pageSize: "A3" }, { marginMm: -1 }, { marginMm: 51 }]) {
      expect(o.safeParse({ images: ["a.jpg"], outputDir: "o", ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(o.safeParse({ images: [], outputDir: "o" }).success).toBe(false);
  });
  it("images_to_pdf options: defaults give no core options; margin converted mm -> pt", () => {
    expect(imageOptions({})).toBeUndefined();
    expect(imageOptions({ pageSize: "fit", marginMm: 0 })).toBeUndefined();
    expect(imageOptions({ pageSize: "A4", marginMm: 0 })).toEqual({ pageSize: "A4", margin: 0 });
    expect(imageOptions({ pageSize: "fit", marginMm: 25.4 })).toEqual({ pageSize: "fit", margin: 72 });
    expect(imageOptions({ pageSize: "Letter", marginMm: 10 })!.margin).toBeCloseTo(28.3465, 3);
    // the largest allowed margin is still below the core's limit (half the shorter side of A4)
    expect(50 * PT_PER_MM).toBeLessThan(Math.min(...PAGE_SIZES.A4) / 2);
  });
});
