import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { core as defaultCore, type PdfCore, type SplitSpec } from "./core/index.js";
import { mapCoreError } from "./errorMap.js";
import { UserError } from "./errors.js";
import { baseOf, outputBase, readInputs, sniff, writePdf } from "./io.js";
import { PathGuard } from "./pathGuard.js";
import {
  imagesToPdfSchema,
  organizeArgsError,
  pdfInfoSchema,
  pdfMergeSchema,
  pdfOrganizeSchema,
  pdfSplitSchema,
  splitArgsError,
} from "./schemas.js";

export const SERVER_NAME = "local-pdf-tools-mcp";
export const SERVER_VERSION = "0.0.0";

/** Tools that write: never overwrite or delete, local only. */
const writeAnn = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const readAnn = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function errorResult(e: unknown) {
  const msg = e instanceof UserError ? `${e.message} [${e.code}]` : "Unexpected error.";
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

function ok(text: string, data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: data };
}

export async function createServer(config: Config, core: PdfCore = defaultCore): Promise<McpServer> {
  const guard = await PathGuard.create(config.allowedRoot);
  const { limits } = config;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const local = `Runs only on this machine; nothing is uploaded. Paths are relative to the allowed root (${guard.root}).`;
  const run = async <T>(fn: () => Promise<T>, file?: string): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw mapCoreError(e, limits, file);
    }
  };

  server.registerTool(
    "pdf_info",
    {
      title: "PDF info",
      description: `Read page count, page sizes and whether a local PDF is encrypted. Does not extract text. ${local}`,
      inputSchema: pdfInfoSchema,
      annotations: { ...readAnn, title: "PDF info" },
    },
    async (a) => {
      try {
        const [f] = await readInputs(guard, [a.input], limits, "pdf");
        const info = await run(() => core.info(f.bytes, limits), a.input);
        return ok(`${a.input}: ${info.pageCount} page(s)${info.encrypted ? ", encrypted" : ""}.`, { ...info });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "pdf_merge",
    {
      title: "Merge PDFs",
      description: `Merge 2-${limits.maxFiles} local PDFs into one new file, in the given order. Encrypted PDFs are refused, never decrypted. Writes a new file; never overwrites. ${local}`,
      inputSchema: pdfMergeSchema,
      annotations: { ...writeAnn, title: "Merge PDFs" },
    },
    async (a) => {
      try {
        const base = outputBase(a.outputName, "merged");
        const files = await readInputs(guard, a.inputs, limits, "pdf");
        const outDir = await guard.resolveOutputDir(a.outputDir);
        const bytes = await run(() => core.merge(files.map((f) => f.bytes), limits));
        const output = await writePdf(guard, outDir, base, bytes);
        return ok(`Merged ${files.length} file(s) into ${output}.`, { output, bytes: bytes.byteLength });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "pdf_split",
    {
      title: "Split PDF",
      description: `Split a local PDF by page ranges, into chunks of n pages, or extract selected pages into one file. Writes new files; never overwrites. ${local}`,
      inputSchema: pdfSplitSchema,
      annotations: { ...writeAnn, title: "Split PDF" },
    },
    async (a) => {
      try {
        const bad = splitArgsError(a);
        if (bad) throw new UserError(bad, "BAD_ARGS");
        const spec: SplitSpec =
          a.mode === "ranges" ? { mode: "ranges", ranges: a.ranges! } : a.mode === "every_n" ? { mode: "every_n", n: a.n! } : { mode: "extract", pages: a.pages! };
        const [f] = await readInputs(guard, [a.input], limits, "pdf");
        const outDir = await guard.resolveOutputDir(a.outputDir);
        const parts = await run(() => core.split(f.bytes, spec, limits), a.input);
        const base = baseOf(a.input);
        const outputs: string[] = [];
        for (const [i, p] of parts.entries()) outputs.push(await writePdf(guard, outDir, `${base}-part${i + 1}`, p));
        return ok(`Wrote ${outputs.length} file(s):\n${outputs.join("\n")}`, { outputs });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "pdf_organize",
    {
      title: "Reorder, rotate or delete PDF pages",
      description: `Reorder, rotate and/or delete pages of a local PDF and save the result as a new file. ${local}`,
      inputSchema: pdfOrganizeSchema,
      annotations: { ...writeAnn, title: "Organize PDF pages" },
    },
    async (a) => {
      try {
        const bad = organizeArgsError(a);
        if (bad) throw new UserError(bad, "BAD_ARGS");
        const base = outputBase(a.outputName, `${baseOf(a.input)}-organized`);
        const [f] = await readInputs(guard, [a.input], limits, "pdf");
        const outDir = await guard.resolveOutputDir(a.outputDir);
        const rotate = a.rotate ? Object.fromEntries(Object.entries(a.rotate).map(([k, v]) => [Number(k), v])) : undefined;
        const bytes = await run(() => core.organize(f.bytes, { order: a.order, rotate, delete: a.delete }, limits), a.input);
        const output = await writePdf(guard, outDir, base, bytes);
        return ok(`Saved ${output}.`, { output, bytes: bytes.byteLength });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "images_to_pdf",
    {
      title: "Images to PDF",
      description: `Combine 1-${limits.maxFiles} local JPEG/PNG images into one PDF (one image per page). EXIF, GPS and other metadata are removed. Max ${limits.maxImageMegapixels} MP per image. ${local}`,
      inputSchema: imagesToPdfSchema,
      annotations: { ...writeAnn, title: "Images to PDF" },
    },
    async (a) => {
      try {
        const base = outputBase(a.outputName, "images");
        const files = await readInputs(guard, a.images, limits, "image");
        const outDir = await guard.resolveOutputDir(a.outputDir);
        const images = files.map((f, i) => ({ bytes: f.bytes, type: sniff(f.bytes, "image", a.images[i]) as "jpeg" | "png" }));
        const bytes = await run(() => core.imagesToPdf(images, { pageSize: a.pageSize, marginMm: a.marginMm }, limits));
        const output = await writePdf(guard, outDir, base, bytes);
        return ok(`Created ${output} from ${files.length} image(s).`, { output, bytes: bytes.byteLength });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}
