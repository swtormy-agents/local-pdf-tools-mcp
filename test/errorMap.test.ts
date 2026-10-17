import { describe, expect, it } from "vitest";
import { CoreError } from "../src/core/types";
import { mapCoreError } from "../src/errorMap";
import { CORE_ERROR_CODES, UserError } from "../src/errors";

describe("error mapping", () => {
  it("maps every core code to a UserError with the same code and an actionable message", () => {
    for (const code of CORE_ERROR_CODES) {
      const u = mapCoreError(new CoreError(code, "detail."), "a.pdf");
      expect(u).toBeInstanceOf(UserError);
      expect(u.code).toBe(code);
      expect(u.message.length).toBeGreaterThan(20);
    }
  });
  it("encrypted: never suggests bypassing encryption", () => {
    const u = mapCoreError(new CoreError("PDF_ENCRYPTED", "x"), "a.pdf");
    expect(u.message).toMatch(/never decrypted/);
    expect(u.message).toMatch(/remove the password in the app that created the file/);
  });
  it("limit messages carry the agreed numbers", () => {
    expect(mapCoreError(new CoreError("TOO_LARGE", "")).message).toMatch(/100 MB per file and 300 MB/);
    expect(mapCoreError(new CoreError("TOO_MANY_PAGES", "")).message).toMatch(/1000 pages/);
    expect(mapCoreError(new CoreError("IMAGE_TOO_LARGE", "")).message).toMatch(/50 megapixels/);
  });
  it("has the agreed code list (Ryan's contract)", () => {
    expect([...CORE_ERROR_CODES].sort()).toEqual(
      ["IMAGE_INVALID", "IMAGE_TOO_LARGE", "NOT_IMPLEMENTED", "PAGE_RANGE", "PDF_ENCRYPTED", "PDF_INVALID", "TOO_LARGE", "TOO_MANY_FILES", "TOO_MANY_PAGES", "UNSUPPORTED_IMAGE"].sort(),
    );
  });
  it("image errors are distinct and actionable", () => {
    expect(mapCoreError(new CoreError("UNSUPPORTED_IMAGE", ""), "a.gif").message).toMatch(/not a JPEG or PNG/);
    expect(mapCoreError(new CoreError("IMAGE_INVALID", ""), "a.png").message).toMatch(/damaged/);
  });
  it("recognises core errors by code, not by class (real core has its own error class)", () => {
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
