import { describe, expect, it } from "vitest";
import { ERROR_CODES, PdfToolError } from "@local-pdf-tools/core";
import { mapCoreError } from "../src/errorMap";
import { CORE_ERROR_CODES, UserError } from "../src/errors";

describe("error mapping", () => {
  it("uses the core's own ERROR_CODES list", () => {
    expect(CORE_ERROR_CODES).toBe(ERROR_CODES);
    expect([...CORE_ERROR_CODES].sort()).toEqual(
      ["IMAGE_INVALID", "IMAGE_TOO_LARGE", "PAGE_RANGE", "PDF_ENCRYPTED", "PDF_INVALID", "TOO_LARGE", "TOO_MANY_FILES", "TOO_MANY_PAGES", "UNSUPPORTED_IMAGE"].sort(),
    );
  });
  it("maps every core code to a UserError with the same code and an actionable message", () => {
    for (const code of CORE_ERROR_CODES) {
      const u = mapCoreError(new PdfToolError(code, "detail."), { file: "a.pdf" });
      expect(u).toBeInstanceOf(UserError);
      expect(u.code).toBe(code);
      expect(u.message.length).toBeGreaterThan(20);
    }
  });
  it("encrypted: never suggests bypassing encryption", () => {
    const u = mapCoreError(new PdfToolError("PDF_ENCRYPTED", "x"), { file: "a.pdf" });
    expect(u.message).toMatch(/never decrypted/);
    expect(u.message).toMatch(/remove the password in the app that created the file/);
  });
  it("limit messages carry the core's numbers", () => {
    expect(mapCoreError(new PdfToolError("TOO_LARGE", "")).message).toMatch(/100 MB per file and 300 MB/);
    expect(mapCoreError(new PdfToolError("TOO_MANY_PAGES", "")).message).toMatch(/1000 pages/);
    expect(mapCoreError(new PdfToolError("TOO_MANY_FILES", "")).message).toMatch(/max 50/);
    expect(mapCoreError(new PdfToolError("IMAGE_TOO_LARGE", "")).message).toMatch(/50 megapixels/);
  });
  it("names the failing input of a multi-file call from details.index", () => {
    const u = mapCoreError(new PdfToolError("PDF_ENCRYPTED", "x", { index: 1 }), { files: ["a.pdf", "secret.pdf"], op: "merge" });
    expect(u.message).toMatch(/\(secret\.pdf\)/);
  });
  it("PAGE_RANGE is built from details in 1-based words, never from the core message", () => {
    const pr = (details: Record<string, unknown>, ctx: Parameters<typeof mapCoreError>[1]) =>
      mapCoreError(new PdfToolError("PAGE_RANGE", "order index out of range 0-2 CORE-MESSAGE", details), ctx).message;
    // organize: bad order entry {index (position in order), page (0-based original), pageCount}
    const o = pr({ index: 2, page: 5, pageCount: 3 }, { file: "a.pdf", op: "organize" });
    expect(o).toMatch(/\(a\.pdf\): page 6 \(position 3 in order\) does not exist \(the document has 3 pages\)/);
    expect(o).not.toMatch(/CORE-MESSAGE|0-2/);
    expect(pr({ index: 0, page: null, pageCount: 3 }, { file: "a.pdf", op: "organize" })).toMatch(/position 1 in order is not a page number/);
    expect(pr({ page: 7, pageCount: 3 }, { file: "a.pdf", op: "organize" })).toMatch(/page 8 in rotate does not exist/);
    expect(pr({ page: 0, degrees: 45, pageCount: 3 }, { file: "a.pdf", op: "organize" })).toMatch(/rotation of page 1 must be a multiple of 90/);
    expect(pr({ pageCount: 1 }, { file: "a.pdf", op: "organize" })).toMatch(/no pages would be left \(the document has 1 page\)/);
    // organize: details.index is a position in order, never an input name
    expect(pr({ index: 1, page: 9, pageCount: 3 }, { files: ["x.pdf", "y.pdf"], op: "organize" })).not.toMatch(/y\.pdf/);
    // merge: names the file from details.index; position/page in 1-based words
    const m = pr({ index: 1, position: 0, page: 4, pageCount: 2 }, { files: ["a.pdf", "b.pdf"], op: "merge" });
    expect(m).toMatch(/\(b\.pdf\): page 5 \(position 1 in pages\) does not exist \(the document has 2 pages\)/);
    // merge used for split extract: the caller's own page value wins
    expect(pr({ index: 0, position: 1, page: 9, pageCount: 3 }, { file: "a.pdf", op: "merge", pages: [1, 10] })).toMatch(/page 10 \(position 2 in pages\)/);
    expect(pr({ index: 0, from: 4, to: 6, pageCount: 3 }, { files: ["a.pdf"], op: "merge" })).toMatch(/\(a\.pdf\): pages 4-6 are outside the document \(the document has 3 pages\)/);
    expect(pr({ index: 0, pageCount: 3 }, { files: ["a.pdf"], op: "merge" })).toMatch(/the page selection is empty/);
    // split
    expect(pr({ from: 2, to: 5, pageCount: 3 }, { file: "a.pdf", op: "split" })).toMatch(/range 2-5 is outside the document \(the document has 3 pages\)/);
    expect(pr({ from: 4, to: 2 }, { file: "a.pdf", op: "split" })).toMatch(/range 4-2 is reversed/);
    // unknown shape: generic text, still no core message
    const g = pr({}, { file: "a.pdf" });
    expect(g).toMatch(/a page number does not exist/);
    expect(g).not.toMatch(/CORE-MESSAGE/);
  });
  it("images_to_pdf option errors (details.option) are reported as options, not as a broken PDF", () => {
    expect(mapCoreError(new PdfToolError("PDF_INVALID", "x", { option: "margin", max: 297.64 }), { files: ["a.jpg"], op: "images" }).message).toMatch(/Invalid images_to_pdf marginMm/);
    expect(mapCoreError(new PdfToolError("PDF_INVALID", "x", { option: "pageSize" }), { op: "images" }).message).toMatch(/Invalid images_to_pdf pageSize/);
    expect(mapCoreError(new PdfToolError("PDF_INVALID", "x"), { file: "a.pdf" }).message).toMatch(/not a valid PDF/);
  });
  it("image errors are distinct and actionable", () => {
    expect(mapCoreError(new PdfToolError("UNSUPPORTED_IMAGE", ""), { file: "a.jpg" }).message).toMatch(/not a JPEG or PNG \(detected from the file contents/);
    expect(mapCoreError(new PdfToolError("IMAGE_INVALID", ""), { file: "a.png" }).message).toMatch(/damaged/);
  });
  it("recognises core errors by code, not by class (a second copy of the core still maps)", () => {
    class ForeignCoreError extends Error {
      code = "PAGE_RANGE";
    }
    expect(mapCoreError(new ForeignCoreError("page 9 of 3.")).code).toBe("PAGE_RANGE");
    const unknown = new Error("x") as Error & { code: string };
    unknown.code = "EACCES";
    expect(mapCoreError(unknown).code).toBe("INTERNAL");
  });
  it("does not leak unknown internal errors", () => {
    const u = mapCoreError(new Error("secret internal stack /home/x"));
    expect(u.code).toBe("INTERNAL");
    expect(u.message).not.toMatch(/home/);
  });
});
