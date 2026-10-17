import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCounts, checkSizes, outputBase, readInputs, sniff } from "../src/io";
import { DEFAULT_LIMITS } from "../src/limits";
import { PathGuard } from "../src/pathGuard";
import { FIXTURES, tmpRoot } from "./helpers";

const MB = 1024 * 1024;
const L = DEFAULT_LIMITS;

describe("limits", () => {
  it("has the agreed shared values", () => {
    expect(L).toEqual({ maxFileBytes: 100 * MB, maxTotalBytes: 300 * MB, maxResultPages: 1000, maxFiles: 50, maxImageMegapixels: 50 });
    expect(Object.isFrozen(L)).toBe(true);
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
  it("sniffs PDF and image signatures", () => {
    expect(sniff(Buffer.from("%PDF-1.7\n"), "pdf", "a")).toBe("pdf");
    expect(() => sniff(Buffer.from("hello"), "pdf", "a")).toThrow(expect.objectContaining({ code: "PDF_INVALID" }));
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image", "a")).toBe("jpeg");
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image", "a")).toBe("png");
    expect(() => sniff(Buffer.from("GIF89a"), "image", "a")).toThrow(expect.objectContaining({ code: "IMAGE_INVALID" }));
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
    const [f] = await readInputs(g, ["a.pdf"], L, "pdf");
    expect(Buffer.from(f.bytes).toString("latin1")).toMatch(/^%PDF-1\.7/);
    await expect(readInputs(g, ["bad.pdf"], L, "pdf")).rejects.toMatchObject({ code: "PDF_INVALID" });
    await expect(readInputs(g, ["a.pdf"], { ...L, maxFileBytes: 10 }, "pdf")).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(readInputs(g, ["a.pdf", "a.pdf"], { ...L, maxTotalBytes: 400 }, "pdf")).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(readInputs(g, ["../x.pdf"], L, "pdf")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
  });
});
