/**
 * End-to-end tool tests: MCP client -> server -> REAL @local-pdf-tools/core, with the core's own fixtures
 * (@local-pdf-tools/core/fixtures). Output PDFs are read back with pdf-lib (updateMetadata:false).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { imagesToPdf, PAGE_SIZES } from "@local-pdf-tools/core";
import * as fx from "@local-pdf-tools/core/fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import { tmpRoot } from "./helpers";
import { allObjectText, assertCleanPdf, jpegMarkers, jpegStreams, loadPdf, rotations, widths } from "./pdfAssert";

/** Minimal ISO-BMFF header of a HEIC file ("ftypheic"); not JPEG/PNG by signature. */
const HEIC = Uint8Array.from([0, 0, 0, 0x18, ...Buffer.from("ftypheicmif1heicmif1"), 0, 0, 0, 0, ...new Array(64).fill(0)]);

let client: Client;
let root: string;
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const call = async (name: string, args: Record<string, unknown>): Promise<any> => client.callTool({ name, arguments: args });
const expectError = async (name: string, args: Record<string, unknown>, code: string) => {
  const r = await call(name, args);
  expect(r.isError, text(r)).toBe(true);
  expect(text(r)).toContain(`[${code}]`);
  return text(r);
};

beforeAll(async () => {
  root = await tmpRoot();
  const files: Record<string, Uint8Array> = {
    "p3.pdf": await fx.plainPdf(3),
    "p2.pdf": await fx.plainPdf(2),
    "p1.pdf": await fx.plainPdf(1),
    "evil.pdf": await fx.evilPdf(),
    "encrypted.pdf": fx.encryptedPdf(),
    "truncated.pdf": fx.truncatedPdf(),
    "corrupt.pdf": fx.corruptBytes(),
    "plain.jpg": fx.plainJpeg(),
    "gps.jpg": fx.exifJpeg(),
    "rot6.jpg": fx.orientedJpeg(6),
    "meta.png": fx.metadataPng(),
    "png-named.jpg": fx.plainPng(),
    "heic-named.jpg": HEIC,
    "photo.heic": HEIC,
    "anim.gif": Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"),
    "huge.jpg": fx.jpegWithSize(10000, 10000),
    "huge.png": fx.pngWithSize(10000, 10000),
    "broken.jpg": Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01),
  };
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(root, name), bytes);
  const server = await createServer({ allowedRoot: root });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(ct);
});

describe("pdf_info", () => {
  it("returns the page count", async () => {
    const r = await call("pdf_info", { input: "p3.pdf" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ pageCount: 3 }); // no encrypted field: encrypted input fails with PDF_ENCRYPTED
  });
  it("encrypted -> PDF_ENCRYPTED, damaged -> PDF_INVALID", async () => {
    expect(await expectError("pdf_info", { input: "encrypted.pdf" }, "PDF_ENCRYPTED")).toMatch(/never decrypted/);
    await expectError("pdf_info", { input: "truncated.pdf" }, "PDF_INVALID"); // passes the %PDF- sniff, rejected by the core
    await expectError("pdf_info", { input: "corrupt.pdf" }, "PDF_INVALID"); // rejected by the MCP sniff
  });
});

describe("pdf_merge", () => {
  it("merges in order into a clean new PDF", async () => {
    const r = await call("pdf_merge", { inputs: ["p3.pdf", "p2.pdf"], outputDir: "merge", outputName: "m" });
    expect(r.isError, text(r)).toBeFalsy();
    const doc = await loadPdf(r.structuredContent.output);
    expect(widths(doc)).toEqual([101, 102, 103, 101, 102]);
    expect(assertCleanPdf(doc)).toEqual([]);
  });
  it("strips Info/XMP/JS/forms/attachments; only the http(s) URI link survives", async () => {
    const r = await call("pdf_merge", { inputs: ["evil.pdf", "p1.pdf"], outputDir: "merge", outputName: "evil" });
    expect(r.isError, text(r)).toBeFalsy();
    const doc = await loadPdf(r.structuredContent.output);
    expect(doc.getPageCount()).toBe(3);
    expect(assertCleanPdf(doc)).toEqual([fx.SAFE_LINK_URI]);
    expect(allObjectText(doc)).not.toContain(fx.EVIL_MARKER);
  });
  it("names the encrypted input; too many files -> TOO_MANY_FILES", async () => {
    expect(await expectError("pdf_merge", { inputs: ["p1.pdf", "encrypted.pdf"], outputDir: "merge" }, "PDF_ENCRYPTED")).toContain("(encrypted.pdf)");
    await expectError("pdf_merge", { inputs: ["p1.pdf", "truncated.pdf"], outputDir: "merge" }, "PDF_INVALID");
    await expectError("pdf_merge", { inputs: Array(51).fill("p1.pdf"), outputDir: "merge" }, "TOO_MANY_FILES");
  });
});

describe("pdf_split", () => {
  it("ranges: one clean file per range, named by pages", async () => {
    const r = await call("pdf_split", { input: "evil.pdf", mode: "ranges", ranges: [{ from: 1, to: 1 }, { from: 2, to: 2 }], outputDir: "split" });
    expect(r.isError, text(r)).toBeFalsy();
    expect(r.structuredContent.files.map((f: any) => [path.basename(f.output), f.pages])).toEqual([
      ["evil-p1.pdf", [1]],
      ["evil-p2.pdf", [2]],
    ]);
    const first = await loadPdf(r.structuredContent.outputs[0]);
    expect(assertCleanPdf(first)).toEqual([fx.SAFE_LINK_URI]);
    expect(allObjectText(first)).not.toContain(fx.EVIL_MARKER);
  });
  it("every_n and extract (listed order, repeats allowed)", async () => {
    const n = await call("pdf_split", { input: "p3.pdf", mode: "every_n", n: 2, outputDir: "split" });
    expect(n.structuredContent.outputs.map((o: string) => path.basename(o))).toEqual(["p3-p1-2.pdf", "p3-p3.pdf"]);
    expect(widths(await loadPdf(n.structuredContent.outputs[1]))).toEqual([103]);
    const x = await call("pdf_split", { input: "p3.pdf", mode: "extract", pages: [3, 1, 3], outputDir: "split" });
    expect(x.isError, text(x)).toBeFalsy();
    const doc = await loadPdf(x.structuredContent.outputs[0]);
    expect(widths(doc)).toEqual([103, 101, 103]);
    assertCleanPdf(doc);
  });
  it("pages outside the document -> PAGE_RANGE (in 1-based words)", async () => {
    const m = await expectError("pdf_split", { input: "p3.pdf", mode: "ranges", ranges: [{ from: 2, to: 5 }], outputDir: "split" }, "PAGE_RANGE");
    expect(m).toContain("(p3.pdf): range 2-5 is outside the document (the document has 3 pages)");
    const x = await expectError("pdf_split", { input: "p3.pdf", mode: "extract", pages: [1, 4], outputDir: "split" }, "PAGE_RANGE");
    expect(x).toContain("(p3.pdf): page 4 (position 2 in pages) does not exist (the document has 3 pages)");
    expect(x).not.toMatch(/0-2/);
    await expectError("pdf_split", { input: "encrypted.pdf", mode: "every_n", n: 1, outputDir: "split" }, "PDF_ENCRYPTED");
  });
});

describe("pdf_organize", () => {
  it("reorders with repeats and rotates by any multiple of 90 (normalized by the core)", async () => {
    const r = await call("pdf_organize", {
      input: "p3.pdf",
      order: [3, 1, 1, 2],
      rotate: [{ page: 1, degrees: 450 }, { page: 2, degrees: -90 }],
      outputDir: "org",
    });
    expect(r.isError, text(r)).toBeFalsy();
    const doc = await loadPdf(r.structuredContent.output);
    expect(widths(doc).length).toBe(4);
    expect(doc.getPages().map((p) => Math.round(p.getSize().width))).toEqual([103, 101, 101, 102]);
    expect(rotations(doc)).toEqual([0, 90, 90, 270]);
    assertCleanPdf(doc);
  });
  it("delete shortcut and rotate-only keep the original order", async () => {
    const d = await call("pdf_organize", { input: "p3.pdf", delete: [2], outputDir: "org", outputName: "del" });
    expect(widths(await loadPdf(d.structuredContent.output))).toEqual([101, 103]);
    const rot = await call("pdf_organize", { input: "p3.pdf", rotate: [{ page: 3, degrees: 180 }, { page: 3, degrees: 180 }], outputDir: "org", outputName: "rot" });
    expect(rotations(await loadPdf(rot.structuredContent.output))).toEqual([0, 0, 0]);
  });
  it("cleans the evil PDF", async () => {
    const r = await call("pdf_organize", { input: "evil.pdf", order: [2, 1], outputDir: "org", outputName: "evil" });
    const doc = await loadPdf(r.structuredContent.output);
    expect(assertCleanPdf(doc)).toEqual([fx.SAFE_LINK_URI]);
    expect(allObjectText(doc)).not.toContain(fx.EVIL_MARKER);
  });
  it("errors: PAGE_RANGE (unknown page, nothing left), TOO_MANY_PAGES, PDF_ENCRYPTED", async () => {
    const o = await expectError("pdf_organize", { input: "p3.pdf", order: [2, 4], outputDir: "org" }, "PAGE_RANGE");
    expect(o).toContain("(p3.pdf): page 4 (position 2 in order) does not exist (the document has 3 pages)");
    expect(o).not.toMatch(/0-2/);
    const none = await expectError("pdf_organize", { input: "p3.pdf", delete: [1, 2, 3], outputDir: "org" }, "PAGE_RANGE");
    expect(none).toContain("no pages would be left (the document has 3 pages)");
    expect(none).not.toMatch(/order must be/);
    await expectError("pdf_organize", { input: "p3.pdf", delete: [7], outputDir: "org" }, "PAGE_RANGE");
    await expectError("pdf_organize", { input: "p1.pdf", order: Array(1001).fill(1), outputDir: "org" }, "TOO_MANY_PAGES");
    await expectError("pdf_organize", { input: "encrypted.pdf", order: [1], outputDir: "org" }, "PDF_ENCRYPTED");
  });
});

describe("images_to_pdf", () => {
  it("one page per image, page = image size, EXIF orientation applied; PNG named .jpg is processed as PNG", async () => {
    const r = await call("images_to_pdf", { images: ["plain.jpg", "rot6.jpg", "meta.png", "png-named.jpg"], outputDir: "img" });
    expect(r.isError, text(r)).toBeFalsy();
    const doc = await loadPdf(r.structuredContent.output);
    expect(doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())])).toEqual([
      [24, 16],
      [16, 24], // orientation 6 swaps width and height
      [8, 8],
      [8, 8],
    ]);
    assertCleanPdf(doc);
    expect(allObjectText(doc)).not.toContain(fx.EVIL_MARKER);
  });
  it("strips EXIF incl. GPS from JPEGs (no APP1/APP13/COM segments in the embedded image)", async () => {
    const r = await call("images_to_pdf", { images: ["gps.jpg"], outputDir: "img", outputName: "gps" });
    expect(r.isError, text(r)).toBeFalsy();
    const doc = await loadPdf(r.structuredContent.output);
    assertCleanPdf(doc);
    const [jpeg] = jpegStreams(doc);
    expect(jpeg).toBeDefined();
    const markers = jpegMarkers(jpeg);
    expect(markers).toContain(0xda);
    for (const m of [0xe1, 0xed, 0xfe]) expect(markers).not.toContain(m);
    const raw = Buffer.from(jpeg).toString("latin1");
    expect(raw).not.toContain("Exif\0\0");
    expect(raw).not.toContain(fx.EVIL_MARKER);
    // The source really had GPS EXIF (so the test proves stripping, without depending on the coordinates).
    expect(jpegMarkers(fx.exifJpeg())).toContain(0xe1);
  });
  it("errors: UNSUPPORTED_IMAGE (HEIC, also renamed .jpg; GIF), IMAGE_TOO_LARGE, IMAGE_INVALID, TOO_MANY_FILES", async () => {
    expect(await expectError("images_to_pdf", { images: ["plain.jpg", "heic-named.jpg"], outputDir: "img" }, "UNSUPPORTED_IMAGE")).toContain("(heic-named.jpg)");
    await expectError("images_to_pdf", { images: ["photo.heic"], outputDir: "img" }, "UNSUPPORTED_IMAGE");
    await expectError("images_to_pdf", { images: ["anim.gif"], outputDir: "img" }, "UNSUPPORTED_IMAGE");
    expect(await expectError("images_to_pdf", { images: ["huge.jpg"], outputDir: "img" }, "IMAGE_TOO_LARGE")).toMatch(/50 megapixels/);
    await expectError("images_to_pdf", { images: ["huge.png"], outputDir: "img" }, "IMAGE_TOO_LARGE");
    expect(await expectError("images_to_pdf", { images: ["broken.jpg"], outputDir: "img" }, "IMAGE_INVALID")).toContain("(broken.jpg)");
    await expectError("images_to_pdf", { images: Array(51).fill("plain.jpg"), outputDir: "img" }, "TOO_MANY_FILES");
  });
  it("failed calls write nothing", async () => {
    const out = await fs.readdir(path.join(root, "img"));
    expect(out.sort()).toEqual(["gps.pdf", "images.pdf"]);
  });
  it("default options (fit, 0 mm) give exactly the core's default output", async () => {
    const r = await call("images_to_pdf", { images: ["plain.jpg", "meta.png"], outputDir: "img-opt", outputName: "default" });
    expect(r.isError, text(r)).toBeFalsy();
    const expected = await imagesToPdf([{ bytes: fx.plainJpeg() }, { bytes: fx.metadataPng() }]);
    expect(Buffer.from(await fs.readFile(r.structuredContent.output)).equals(Buffer.from(expected))).toBe(true);
  });
  it("pageSize A4/Letter from PAGE_SIZES; marginMm converted to points", async () => {
    const a4 = await call("images_to_pdf", { images: ["plain.jpg", "rot6.jpg"], pageSize: "A4", marginMm: 10, outputDir: "img-opt", outputName: "a4" });
    expect(a4.isError, text(a4)).toBeFalsy();
    const docA4 = await loadPdf(a4.structuredContent.output);
    for (const p of docA4.getPages()) expect([p.getWidth(), p.getHeight()]).toEqual([...PAGE_SIZES.A4]);
    assertCleanPdf(docA4);
    const letter = await call("images_to_pdf", { images: ["meta.png"], pageSize: "Letter", outputDir: "img-opt", outputName: "letter" });
    const [lp] = (await loadPdf(letter.structuredContent.output)).getPages();
    expect([lp.getWidth(), lp.getHeight()]).toEqual([...PAGE_SIZES.Letter]);
    // fit + 25.4 mm (= 72 pt) on every side: the 24x16 image page grows by 144 pt in each direction
    const fit = await call("images_to_pdf", { images: ["plain.jpg"], marginMm: 25.4, outputDir: "img-opt", outputName: "fit-margin" });
    const [fp] = (await loadPdf(fit.structuredContent.output)).getPages();
    expect([Math.round(fp.getWidth()), Math.round(fp.getHeight())]).toEqual([24 + 144, 16 + 144]);
  });
  it("bad options are refused by the schema before any file is read or written", async () => {
    const r = await call("images_to_pdf", { images: ["plain.jpg"], pageSize: "A3", outputDir: "img-bad" });
    expect(r.isError).toBe(true);
    const m = await call("images_to_pdf", { images: ["plain.jpg"], marginMm: 60, outputDir: "img-bad" });
    expect(m.isError).toBe(true);
    await expect(fs.readdir(path.join(root, "img-bad"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
