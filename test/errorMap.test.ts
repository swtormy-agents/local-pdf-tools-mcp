import { describe, expect, it } from "vitest";
import { CoreError } from "../src/core/types";
import { mapCoreError } from "../src/errorMap";
import { CORE_ERROR_CODES, UserError } from "../src/errors";
import { DEFAULT_LIMITS } from "../src/limits";

describe("error mapping", () => {
  it("maps every core code to a UserError with the same code and an actionable message", () => {
    for (const code of CORE_ERROR_CODES) {
      const u = mapCoreError(new CoreError(code, "detail."), DEFAULT_LIMITS, "a.pdf");
      expect(u).toBeInstanceOf(UserError);
      expect(u.code).toBe(code);
      expect(u.message.length).toBeGreaterThan(20);
    }
  });
  it("encrypted: never suggests bypassing encryption", () => {
    const u = mapCoreError(new CoreError("PDF_ENCRYPTED", "x"), DEFAULT_LIMITS, "a.pdf");
    expect(u.message).toMatch(/never decrypted/);
    expect(u.message).toMatch(/remove the password in the app that created the file/);
  });
  it("limit messages carry the agreed numbers", () => {
    expect(mapCoreError(new CoreError("TOO_LARGE", ""), DEFAULT_LIMITS).message).toMatch(/100 MB per file and 300 MB/);
    expect(mapCoreError(new CoreError("TOO_MANY_PAGES", ""), DEFAULT_LIMITS).message).toMatch(/1000 pages/);
    expect(mapCoreError(new CoreError("IMAGE_TOO_LARGE", ""), DEFAULT_LIMITS).message).toMatch(/50 megapixels/);
  });
  it("does not leak unknown internal errors", () => {
    const u = mapCoreError(new Error("secret internal stack /home/x"), DEFAULT_LIMITS);
    expect(u.code).toBe("INTERNAL");
    expect(u.message).not.toMatch(/home/);
  });
});
