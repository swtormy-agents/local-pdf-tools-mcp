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
      const u = mapCoreError(new PdfToolError(code, "detail."), "a.pdf");
      expect(u).toBeInstanceOf(UserError);
      expect(u.code).toBe(code);
      expect(u.message.length).toBeGreaterThan(20);
    }
  });
  it("encrypted: never suggests bypassing encryption", () => {
    const u = mapCoreError(new PdfToolError("PDF_ENCRYPTED", "x"), "a.pdf");
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
    const u = mapCoreError(new PdfToolError("PDF_ENCRYPTED", "x", { index: 1 }), undefined, ["a.pdf", "secret.pdf"]);
    expect(u.message).toMatch(/\(secret\.pdf\)/);
  });
  it("PAGE_RANGE never shows the core's 0-based indexes", () => {
    expect(mapCoreError(new PdfToolError("PAGE_RANGE", "order index out of range 0-2")).message).not.toMatch(/0-2/);
    expect(mapCoreError(new PdfToolError("PAGE_RANGE", "Page out of range 1-3")).message).toMatch(/Page out of range 1-3\./);
  });
  it("image errors are distinct and actionable", () => {
    expect(mapCoreError(new PdfToolError("UNSUPPORTED_IMAGE", ""), "a.jpg").message).toMatch(/not a JPEG or PNG \(detected from the file contents/);
    expect(mapCoreError(new PdfToolError("IMAGE_INVALID", ""), "a.png").message).toMatch(/damaged/);
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
