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
  it("pdf_organize accepts only 90/180/270 rotations and needs an operation", () => {
    const s = obj(pdfOrganizeSchema);
    expect(s.safeParse({ input: "a.pdf", rotate: { "1": 45 }, outputDir: "o" }).success).toBe(false);
    expect(s.safeParse({ input: "a.pdf", rotate: { "0": 90 }, outputDir: "o" }).success).toBe(false);
    expect(s.safeParse({ input: "a.pdf", rotate: { "2": 90 }, outputDir: "o" }).success).toBe(true);
    expect(organizeArgsError({})).toMatch(/at least one/);
  });
  it("images_to_pdf defaults and bounds", () => {
    const r = obj(imagesToPdfSchema).parse({ images: ["a.jpg"], outputDir: "o" });
    expect(r.pageSize).toBe("a4");
    expect(r.marginMm).toBe(0);
    expect(obj(imagesToPdfSchema).safeParse({ images: ["a.jpg"], outputDir: "o", marginMm: 100 }).success).toBe(false);
  });
});
