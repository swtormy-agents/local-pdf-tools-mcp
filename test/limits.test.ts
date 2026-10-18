import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS as CORE_LIMITS } from "@local-pdf-tools/core";
import { checkCounts, checkSizes, outputBase, readInputs, sniffPdf } from "../src/io";
import { LIMITS } from "../src/limits";
import { PathGuard } from "../src/pathGuard";
import { FIXTURES, tmpRoot } from "./helpers";

const MB = 1024 * 1024;
const L = LIMITS;

describe("limits", () => {
  it("is the core's LIMITS object with the agreed values", () => {
    expect(L).toBe(CORE_LIMITS);
    expect(L).toEqual({ MAX_FILE_BYTES: 100 * MB, MAX_TOTAL_BYTES: 300 * MB, MAX_PAGES: 1000, MAX_FILES: 50, MAX_IMAGE_PIXELS: 50_000_000 });
    expect(Object.isFrozen(L)).toBe(true);
  });
  it("defaults to the shared LIMITS", () => {
    expect(() => checkCounts(51)).toThrow(expect.objectContaining({ code: "TOO_MANY_FILES" }));
    expect(() => checkSizes([100 * MB + 1])).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
  });
  it("file count", () => {
    expect(() => checkCounts(0, L)).toThrow(expect.objectContaining({ code: "NO_INPUT" }));
    expect(() => checkCounts(50, L)).not.toThrow();
    expect(() => checkCounts(51, L)).toThrow(expect.objectContaining({ code: "TOO_MANY_FILES" }));
  });
  it("per-file and total size", () => {
    expect(() => checkSizes([100 * MB], L)).not.toThrow();
    expect(() => checkSizes([100 * MB + 1], L)).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
    expect(() => checkSizes([100 * MB, 100 * MB, 100 * MB], L)).not.toThrow();
    expect(() => checkSizes([100 * MB, 100 * MB, 100 * MB, 1], L)).toThrow(/max 300 MB/);
  });
  it("sniffs the PDF signature (images are detected by the core only)", () => {
    expect(() => sniffPdf(Buffer.from("%PDF-1.7\n"), "a")).not.toThrow();
    expect(() => sniffPdf(Buffer.from("junk\n%PDF-1.4\n"), "a")).not.toThrow();
    expect(() => sniffPdf(Buffer.from("hello"), "a")).toThrow(expect.objectContaining({ code: "PDF_INVALID" }));
  });
  it("output names are restricted", () => {
    expect(outputBase(undefined, "merged")).toBe("merged");
    expect(outputBase("report.pdf", "x")).toBe("report");
    for (const bad of ["../x", "a/b", ".hidden", "a b", "x:y"]) expect(() => outputBase(bad, "x"), bad).toThrow(expect.objectContaining({ code: "BAD_OUTPUT_NAME" }));
  });
  it("readInputs enforces limits on real files and rejects non-PDFs", async () => {
    const root = await tmpRoot();
    await fs.copyFile(path.join(FIXTURES, "one-page.pdf"), path.join(root, "a.pdf"));
    await fs.copyFile(path.join(FIXTURES, "not-a-pdf.pdf"), path.join(root, "bad.pdf"));
    const g = await PathGuard.create(root);
    const [f] = await readInputs(g, ["a.pdf"], "pdf");
    expect(Buffer.from(f.bytes).toString("latin1")).toMatch(/^%PDF-1\.7/);
    await expect(readInputs(g, ["bad.pdf"], "pdf")).rejects.toMatchObject({ code: "PDF_INVALID" });
    await expect(readInputs(g, ["a.pdf"], "pdf", { ...L, MAX_FILE_BYTES: 10 })).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(readInputs(g, ["a.pdf", "a.pdf"], "pdf", { ...L, MAX_TOTAL_BYTES: 400 })).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(readInputs(g, ["../x.pdf"], "pdf")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
  });
});
