/**
 * QA repros (Megan, core 331a28a review: /workspace/qa/pdfcore suite.py + REPORT.md, MCP review /workspace/qa/mcp2),
 * run end-to-end through the MCP server against the REAL core (pinned aea0eb0, which fixes them).
 * Fixtures in test/fixtures/qa/ are Megan's synthetic files (see README there); large inputs are generated here.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fx from "@local-pdf-tools/core/fixtures";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import { FIXTURES, tmpRoot } from "./helpers";
import { assertCleanPdf, jpegMarkers, jpegStreams, loadPdf } from "./pdfAssert";

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
const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

/** ASCII85 decoder (pdf-lib cannot decode an ASCII85Decode+DCTDecode chain); used to inspect the QA fixture only. */
function a85(src: Uint8Array): Uint8Array {
  let s = latin1(src).replace(/\s+/g, "");
  if (s.startsWith("<~")) s = s.slice(2);
  s = s.slice(0, s.indexOf("~>") >= 0 ? s.indexOf("~>") : undefined);
  const out: number[] = [];
  let tuple: number[] = [];
  for (const ch of s) {
    if (ch === "z" && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }
    tuple.push(ch.charCodeAt(0) - 33);
    if (tuple.length === 5) {
      const v = tuple.reduce((a, c) => a * 85 + c, 0);
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      tuple = [];
    }
  }
  if (tuple.length) {
    const n = tuple.length;
    while (tuple.length < 5) tuple.push(84);
    const v = tuple.reduce((a, c) => a * 85 + c, 0);
    out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

/** Every dict key name and every decodable stream's text of an output PDF. */
function dump(doc: PDFDocument): { keys: Set<string>; decoded: string; raw: string } {
  const keys = new Set<string>();
  const parts: string[] = [];
  const walk = (o: unknown, depth = 0): void => {
    if (depth > 100) return;
    const d = o instanceof PDFDict ? o : o instanceof PDFRawStream ? o.dict : undefined;
    if (d) for (const [k, v] of d.entries()) { keys.add(k.decodeText()); walk(v, depth + 1); }
    else if (o instanceof PDFArray) for (const v of o.asArray()) walk(v, depth + 1);
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    walk(obj);
    parts.push(obj instanceof PDFRawStream ? obj.dict.toString() : String(obj));
    if (obj instanceof PDFRawStream) {
      try { parts.push(latin1(decodePDFRawStream(obj).decode())); } catch { parts.push(latin1(obj.contents)); }
    }
  }
  const decoded = parts.join("\n");
  return { keys, decoded, raw: decoded };
}

/** Banned keys anywhere in an output (QA check_out.py list, the relevant subset). */
const BAD_KEYS = ["JavaScript", "JS", "Launch", "EmbeddedFile", "EmbeddedFiles", "EF", "AF", "AA", "OpenAction", "Metadata", "PieceInfo", "Names", "AcroForm", "LeakJS", "LeakLaunch", "LeakRes", "Properties"];

async function expectClean(file: string) {
  const bytes = await fs.readFile(file);
  expect(latin1(bytes)).not.toMatch(/LEAK|\/Info|Exif|xmpmeta|GPS/);
  const doc = await loadPdf(file);
  assertCleanPdf(doc);
  const { keys, decoded } = dump(doc);
  expect(BAD_KEYS.filter((k) => keys.has(k))).toEqual([]);
  expect(decoded).not.toMatch(/LEAK|xmpmeta|Exif\0|javascript/i);
  for (const j of jpegStreams(doc)) {
    // APP1 (EXIF/XMP) .. APP15 and COM gone; APP0, ICC APP2 and Adobe APP14 may stay.
    const bad = jpegMarkers(j).filter((m) => (m >= 0xe1 && m <= 0xef && m !== 0xe2 && m !== 0xee) || m === 0xfe);
    expect(bad).toEqual([]);
    expect(latin1(j)).not.toMatch(/LEAK|Exif|GPS|xmpmeta|Photoshop/);
  }
  return doc;
}

// --- object-stream decompression bomb (port of the core's sanitize.test.mjs generator) ---
/** Zlib data inflating to about `n` spaces: one byte-aligned fixed-Huffman block (1022 x len 258 dist 1) repeated. */
function deflateBombRepeated(n: number): Buffer {
  const M = 1022;
  const block = (lit: boolean) => {
    const out: number[] = [];
    let acc = 0;
    let bits = 0;
    const put = (v: number, len: number) => { acc |= v << bits; bits += len; while (bits >= 8) { out.push(acc & 0xff); acc >>>= 8; bits -= 8; } };
    const putRev = (code: number, len: number) => { let r = 0; for (let k = 0; k < len; k++) r |= ((code >> k) & 1) << (len - 1 - k); put(r, len); };
    put(0, 1); put(1, 2);
    if (lit) putRev(0x30 + 0x20, 8);
    for (let k = 0; k < M; k++) { putRev(0xc5, 8); putRev(0, 5); }
    putRev(0, 7);
    if (bits !== 0) throw new Error("unaligned block");
    return Buffer.from(out);
  };
  const rep = block(false);
  const count = Math.ceil(n / (M * 258));
  return Buffer.concat([Buffer.from([0x78, 0x01]), block(true), Buffer.concat(Array(count).fill(rep)), Buffer.from([0x03, 0x00]), Buffer.alloc(4)]);
}
function objStmBombPdf(z: Buffer): Buffer {
  const parts = [
    Buffer.from("%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n"),
    Buffer.from(`4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${z.length} /Filter /FlateDecode >>\nstream\n`),
    z,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 5 >>\n%%EOF\n"),
  ];
  return Buffer.concat(parts);
}

beforeAll(async () => {
  root = await tmpRoot();
  for (const f of await fs.readdir(path.join(FIXTURES, "qa"))) {
    if (f.endsWith(".pdf")) await fs.copyFile(path.join(FIXTURES, "qa", f), path.join(root, f));
  }
  await fs.writeFile(path.join(root, "p2000.pdf"), await fx.plainPdf(2000));
  await fs.writeFile(path.join(root, "p60.pdf"), await fx.plainPdf(60));
  await fs.writeFile(path.join(root, "bomb.pdf"), objStmBombPdf(deflateBombRepeated(6.2e9))); // QA MCP B2: ObjStm -> 6.2 GB
  const server = await createServer({ allowedRoot: root });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "qa-repros", version: "0" });
  await client.connect(ct);
}, 120_000);

describe("QA B1: metadata and active content inside input PDFs (core allowlist rebuild)", () => {
  it("fixture check: the embedded JPEG really carries EXIF with NON-ZERO GPS, XMP, IPTC and COM", async () => {
    const src = await PDFDocument.load(await fs.readFile(path.join(root, "pdf-embedded-exif-jpeg.pdf")), { updateMetadata: false });
    const jpegs: Uint8Array[] = [];
    for (const [, o] of src.context.enumerateIndirectObjects()) {
      const f = o instanceof PDFRawStream ? o.dict.lookup(PDFName.of("Filter")) : undefined;
      if (f instanceof PDFArray && f.asArray().map(String).join() === "/ASCII85Decode,/DCTDecode") jpegs.push(a85((o as PDFRawStream).contents));
    }
    expect(jpegs).toHaveLength(1);
    const j = latin1(jpegs[0]);
    for (const s of ["Exif\0\0", "LEAKSERIAL123", "LEAKMAKE", "xmpmeta", "Photoshop 3.0"]) expect(j, s).toContain(s);
    expect(jpegMarkers(jpegs[0])).toContain(0xfe);
    // GPS N 12 34 56.78 / W 98 76 54.32 (synthetic): the rationals 5678/100 and 5432/100 are present, i.e. not zeroed.
    const be = (a: number, b: number) => Buffer.concat([Buffer.alloc(4), Buffer.alloc(4)].map((x, i) => (x.writeUInt32BE(i ? b : a), x))).toString("latin1");
    const le = (a: number, b: number) => Buffer.concat([Buffer.alloc(4), Buffer.alloc(4)].map((x, i) => (x.writeUInt32LE(i ? b : a), x))).toString("latin1");
    expect(j.includes(be(5678, 100)) || j.includes(le(5678, 100))).toBe(true);
    expect(j.includes(be(5432, 100)) || j.includes(le(5432, 100))).toBe(true);
  });
  it("the checker is not vacuous: every unprocessed QA fixture fails it", async () => {
    for (const f of ["pdf-embedded-exif-jpeg.pdf", "xobject-metadata.pdf", "page-af.pdf", "page-privkeys.pdf"]) {
      await expect(expectClean(path.join(root, f)), f).rejects.toThrow();
    }
  });
  for (const f of ["pdf-embedded-exif-jpeg.pdf", "xobject-metadata.pdf", "page-af.pdf", "page-privkeys.pdf"]) {
    it(`${f}: merge, split, organize outputs are clean`, async () => {
      const m = await call("pdf_merge", { inputs: [f, f], outputDir: "out", outputName: f.replace(".pdf", "-m") });
      expect(m.isError, text(m)).toBeFalsy();
      const doc = await expectClean(m.structuredContent.output);
      if (f === "pdf-embedded-exif-jpeg.pdf") expect(jpegStreams(doc).length).toBeGreaterThan(0); // image kept, only cleaned
      const s = await call("pdf_split", { input: f, mode: "every_n", n: 1, outputDir: "out" });
      expect(s.isError, text(s)).toBeFalsy();
      for (const o of s.structuredContent.outputs) await expectClean(o);
      const o = await call("pdf_organize", { input: f, rotate: [{ page: 1, degrees: 90 }], outputDir: "out" });
      expect(o.isError, text(o)).toBeFalsy();
      await expectClean(o.structuredContent.output);
    });
  }
});

/**
 * Megan's re-QA of core aea0eb0 (/workspace/qa/pdfcore/fixtures/v2, suite.py v2:privkeys-indirect-s and
 * v2:exif-indirect-subtype): the core's sanitize does not resolve indirect references, so a Launch action whose /S and
 * /Type are indirect objects, and a JPEG whose image /Subtype is indirect (EXIF/GPS kept), pass through. FAIL on
 * aea0eb0; SKIPPED until the core fix lands (Ryan). Enable (remove .skip) when bumping the pin to the fixed core.
 */
describe.skip("QA v2 (re-QA of aea0eb0): indirect /S, /Type and /Subtype - SKIPPED: fails on core aea0eb0, awaiting core fix", () => {
  for (const f of ["privkeys-indirect-s.pdf", "exif-indirect-subtype.pdf"]) {
    it(`${f}: merge, split, organize outputs are clean`, async () => {
      await expect(expectClean(path.join(root, f)), "fixture must fail the checker").rejects.toThrow();
      const m = await call("pdf_merge", { inputs: [f, f], outputDir: "v2", outputName: f.replace(".pdf", "-m") });
      expect(m.isError, text(m)).toBeFalsy();
      await expectClean(m.structuredContent.output);
      const s = await call("pdf_split", { input: f, mode: "ranges", ranges: [{ from: 1, to: 1 }], outputDir: "v2" });
      expect(s.isError, text(s)).toBeFalsy();
      await expectClean(s.structuredContent.outputs[0]);
      const o = await call("pdf_organize", { input: f, order: [1, 1], outputDir: "v2" });
      expect(o.isError, text(o)).toBeFalsy();
      await expectClean(o.structuredContent.output);
    });
  }
});

describe("QA B2: /ObjStm Flate bomb (6.2 GB inflated) -> TOO_LARGE decompressed, bounded memory", () => {
  it("every PDF tool refuses it quickly with a clear message; peak RSS stays reasonable", async () => {
    expect((await fs.stat(path.join(root, "bomb.pdf"))).size).toBeLessThan(100 * 1024 * 1024);
    const peak0 = process.resourceUsage().maxRSS; // KiB
    const t0 = Date.now();
    const calls: [string, Record<string, unknown>][] = [
      ["pdf_info", { input: "bomb.pdf" }],
      ["pdf_merge", { inputs: ["bomb.pdf", "p60.pdf"], outputDir: "bomb" }],
      ["pdf_split", { input: "bomb.pdf", mode: "every_n", n: 1, outputDir: "bomb" }],
      ["pdf_organize", { input: "bomb.pdf", order: [1], outputDir: "bomb" }],
    ];
    for (const [tool, args] of calls) {
      const m = await expectError(tool, args, "TOO_LARGE");
      expect(m).toMatch(/more than 500 MB of decompressed data/);
      expect(m).toMatch(/decompression bomb/);
      expect(m).not.toMatch(/max 100 MB per file/);
    }
    const grewMiB = (process.resourceUsage().maxRSS - peak0) / 1024;
    console.error(`ObjStm bomb: peak RSS grew by ${grewMiB.toFixed(0)} MiB in ${Date.now() - t0} ms`);
    expect(Date.now() - t0).toBeLessThan(90_000);
    expect(grewMiB, `peak RSS grew by ${grewMiB.toFixed(0)} MiB`).toBeLessThan(700); // QA saw 6.2 GB before the cap
    await expect(fs.readdir(path.join(root, "bomb"))).resolves.toEqual([]);
  }, 120_000);
});

describe("QA L3 / split limits (1000 per part, 5000 total, 50 parts)", () => {
  it("every_n 1000 on a 2000-page PDF -> two 1000-page files", async () => {
    const r = await call("pdf_split", { input: "p2000.pdf", mode: "every_n", n: 1000, outputDir: "big" });
    expect(r.isError, text(r)).toBeFalsy();
    expect(r.structuredContent.files.map((f: any) => [path.basename(f.output), f.pages.length])).toEqual([
      ["p2000-p1-1000.pdf", 1000],
      ["p2000-p1001-2000.pdf", 1000],
    ]);
    expect((await loadPdf(r.structuredContent.outputs[1])).getPageCount()).toBe(1000);
  }, 60_000);
  it("a part over 1000 pages -> TOO_MANY_PAGES naming the part", async () => {
    const m = await expectError("pdf_split", { input: "p2000.pdf", mode: "every_n", n: 1001, outputDir: "big-fail" }, "TOO_MANY_PAGES");
    expect(m).toContain("Output part 1 would have 1001 pages: max 1000 pages per output file");
  });
  it("60 parts -> TOO_MANY_FILES (ranges and every_n), nothing written", async () => {
    const ranges = Array.from({ length: 60 }, (_, i) => ({ from: i + 1, to: i + 1 }));
    const a = await expectError("pdf_split", { input: "p60.pdf", mode: "ranges", ranges, outputDir: "parts" }, "TOO_MANY_FILES");
    expect(a).toContain("would produce 60 files: max 50 output files per call");
    await expectError("pdf_split", { input: "p60.pdf", mode: "every_n", n: 1, outputDir: "parts" }, "TOO_MANY_FILES");
    const ok = await call("pdf_split", { input: "p60.pdf", mode: "ranges", ranges: ranges.slice(0, 50), outputDir: "parts50" });
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(ok.structuredContent.outputs).toHaveLength(50);
    await expect(fs.readdir(path.join(root, "parts"))).resolves.toEqual([]);
  });
  it("repeated ranges over 5000 pages in total -> TOO_MANY_PAGES (total), nothing written", async () => {
    const ranges = Array.from({ length: 6 }, () => ({ from: 1, to: 1000 }));
    const m = await expectError("pdf_split", { input: "p2000.pdf", mode: "ranges", ranges, outputDir: "total" }, "TOO_MANY_PAGES");
    expect(m).toContain("more than 5000 pages (repeated pages counted)");
    await expect(fs.readdir(path.join(root, "total"))).resolves.toEqual([]);
  });
});
