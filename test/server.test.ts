import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { CoreError, type PdfCore } from "../src/core/types";
import { createServer } from "../src/server";
import { FIXTURES, tmpRoot } from "./helpers";

async function connect(core?: PdfCore) {
  const root = await tmpRoot();
  await fs.copyFile(path.join(FIXTURES, "three-pages.pdf"), path.join(root, "a.pdf"));
  const server = await createServer({ allowedRoot: root }, core);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return { client, root };
}

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("server", () => {
  it("lists the five tools with annotations", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["images_to_pdf", "pdf_info", "pdf_merge", "pdf_organize", "pdf_split"]);
    for (const t of tools) expect(t.annotations?.openWorldHint).toBe(false);
    expect(tools.find((t) => t.name === "pdf_info")!.annotations!.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "pdf_merge")!.annotations!.destructiveHint).toBe(false);
  });
  it("stub core answers NOT_IMPLEMENTED", async () => {
    const { client } = await connect();
    const r: any = await client.callTool({ name: "pdf_info", arguments: { input: "a.pdf" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/NOT_IMPLEMENTED/);
  });
  it("wires a core implementation and writes a new file inside the root", async () => {
    const fake: PdfCore = {
      info: async () => ({ pageCount: 3, pages: [], encrypted: false }),
      merge: async (pdfs) => pdfs[0],
      split: async (pdf) => [
        { pages: [1, 2], bytes: pdf },
        { pages: [3], bytes: pdf },
      ],
      organize: async (pdf) => pdf,
      imagesToPdf: async () => new Uint8Array(),
    };
    const { client, root } = await connect(fake);
    const r: any = await client.callTool({ name: "pdf_merge", arguments: { inputs: ["a.pdf", "a.pdf"], outputDir: "out" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.output).toBe(path.join(root, "out", "merged.pdf"));
    const s: any = await client.callTool({ name: "pdf_split", arguments: { input: "a.pdf", mode: "every_n", n: 2, outputDir: "out" } });
    expect(s.structuredContent.outputs).toEqual([path.join(root, "out", "a-p1-2.pdf"), path.join(root, "out", "a-p3.pdf")]);
    expect(s.structuredContent.files[1].pages).toEqual([3]);
    const again: any = await client.callTool({ name: "pdf_merge", arguments: { inputs: ["a.pdf", "a.pdf"], outputDir: "out" } });
    expect(again.structuredContent.output).toBe(path.join(root, "out", "merged-1.pdf"));
  });
  it("pdf_organize passes 0-based ORIGINAL indices and no limits to the core", async () => {
    const calls: unknown[][] = [];
    const fake = {
      info: async (...args: unknown[]) => {
        calls.push(["info", ...args.slice(1)]);
        return { pageCount: 3, pages: [], encrypted: false };
      },
      organize: async (pdf: Uint8Array, ...rest: unknown[]) => {
        calls.push(["organize", ...rest]);
        return pdf;
      },
    } as unknown as PdfCore;
    const { client, root } = await connect(fake);
    const r: any = await client.callTool({
      name: "pdf_organize",
      arguments: { input: "a.pdf", order: [3, 1], rotate: [{ page: 3, degrees: 90 }], outputDir: "out" },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.output).toBe(path.join(root, "out", "a-organized.pdf"));
    expect(calls).toEqual([["organize", { order: [2, 0], rotate: { 2: 90 } }]]);
    calls.length = 0;
    await client.callTool({ name: "pdf_organize", arguments: { input: "a.pdf", delete: [2], outputDir: "out" } });
    expect(calls).toEqual([["info"], ["organize", { order: [0, 2] }]]);
    const both: any = await client.callTool({ name: "pdf_organize", arguments: { input: "a.pdf", order: [1], delete: [2], outputDir: "out" } });
    expect(text(both)).toMatch(/BAD_ARGS/);
    const bad: any = await client.callTool({ name: "pdf_organize", arguments: { input: "a.pdf", delete: [9], outputDir: "out" } });
    expect(text(bad)).toMatch(/PAGE_RANGE/);
  });
  it("maps core errors (encrypted) and refuses paths outside the root", async () => {
    const enc: PdfCore = {
      info: async () => {
        throw new CoreError("PDF_ENCRYPTED", "enc");
      },
    } as unknown as PdfCore;
    const { client } = await connect(enc);
    const r: any = await client.callTool({ name: "pdf_info", arguments: { input: "a.pdf" } });
    expect(text(r)).toMatch(/PDF_ENCRYPTED/);
    const o: any = await client.callTool({ name: "pdf_info", arguments: { input: "../etc/passwd" } });
    expect(text(o)).toMatch(/PATH_OUTSIDE_ROOT/);
    const m: any = await client.callTool({ name: "pdf_merge", arguments: { inputs: Array(51).fill("a.pdf"), outputDir: "o" } });
    expect(text(m)).toMatch(/TOO_MANY_FILES/);
  });
});

describe("config", () => {
  const home = path.resolve("/home/tester");
  const H = [home];
  it("requires a root and refuses broad or unexpanded ones", () => {
    expect(() => loadConfig([], {}, home, H)).toThrow(expect.objectContaining({ code: "ROOT_REQUIRED" }));
    expect(() => loadConfig(["--root", "/"], {}, home, H)).toThrow(expect.objectContaining({ code: "ROOT_TOO_BROAD" }));
    expect(() => loadConfig(["--root", home], {}, home, H)).toThrow(expect.objectContaining({ code: "ROOT_TOO_BROAD" }));
    expect(() => loadConfig(["--root", "~/docs"], {}, home, H)).toThrow(expect.objectContaining({ code: "ROOT_TILDE" }));
    expect(loadConfig([], { LOCAL_PDF_TOOLS_ROOT: path.resolve("/srv/pdf") }, home, H).allowedRoot).toBe(path.resolve("/srv/pdf"));
    expect(loadConfig(["--root", "/srv/pdf"], {}, home, H)).toEqual({ allowedRoot: path.resolve("/srv/pdf") });
  });
});
