import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { everyNRanges, organizeNeedsPageCount, splitPartBase, toOrganizeOps } from "./adapter.js";
import type { Config } from "./config.js";
import { core as defaultCore, type PdfCore, type SplitPart } from "./core/index.js";
import { mapCoreError, type ErrorContext } from "./errorMap.js";
import { UserError } from "./errors.js";
import { baseOf, outputBase, readInputs, writePdf } from "./io.js";
import { LIMITS } from "./limits.js";
import { PathGuard } from "./pathGuard.js";
import {
  imageOptions,
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
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const local = `Runs only on this machine; nothing is uploaded. Paths are relative to the allowed root (${guard.root}).`;
  /** Call the core; map its errors with the call's context (input name(s), operation, caller's 1-based pages). */
  const run = async <T>(fn: () => Promise<T>, ctx: ErrorContext): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw mapCoreError(e, ctx);
    }
  };

  server.registerTool(
    "pdf_info",
    {
      title: "PDF info",
      description: `Read the page count of a local PDF. Encrypted PDFs are reported as PDF_ENCRYPTED (never decrypted). Does not extract text. ${local}`,
      inputSchema: pdfInfoSchema,
      annotations: { ...readAnn, title: "PDF info" },
    },
    async (a) => {
      try {
        const [f] = await readInputs(guard, [a.input], "pdf");
        const info = await run(() => core.pdfInfo(f.bytes), { file: a.input, op: "info" });
        return ok(`${a.input}: ${info.pages} page(s).`, { pageCount: info.pages });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "pdf_merge",
    {
      title: "Merge PDFs",
      description: `Merge 2-${LIMITS.MAX_FILES} local PDFs into one new file, in the given order (max ${LIMITS.MAX_PAGES} pages in the result). Encrypted PDFs are refused, never decrypted. Writes a new file; never overwrites. ${local}`,
      inputSchema: pdfMergeSchema,
      annotations: { ...writeAnn, title: "Merge PDFs" },
    },
    async (a) => {
      try {
        const base = outputBase(a.outputName, "merged");
        const files = await readInputs(guard, a.inputs, "pdf");
        const outDir = await guard.resolveOutputDir(a.outputDir);
        const bytes = await run(() => core.merge(files.map((f) => ({ bytes: f.bytes }))), { files: a.inputs, op: "merge" });
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
      description: `Split a local PDF by page ranges, into chunks of n pages, or extract selected pages into one file. Page numbers are 1-based. Limits: max ${LIMITS.MAX_PAGES} pages per output file, ${LIMITS.MAX_SPLIT_PARTS} output files and ${LIMITS.MAX_SPLIT_TOTAL_PAGES} pages over all files together (repeats counted); extract writes one file of at most ${LIMITS.MAX_PAGES} pages. Output files are named <input>-p<pages>.pdf (e.g. report-p1-3.pdf). Writes new files; never overwrites. ${local}`,
      inputSchema: pdfSplitSchema,
      annotations: { ...writeAnn, title: "Split PDF" },
    },
    async (a) => {
      try {
        const bad = splitArgsError(a);
        if (bad) throw new UserError(bad, "BAD_ARGS");
        const [f] = await readInputs(guard, [a.input], "pdf");
        const outDir = await guard.resolveOutputDir(a.outputDir);
        let parts: SplitPart[];
        if (a.mode === "extract") {
          // One output with the listed pages in the listed order (repeats allowed): a one-item merge with 0-based indexes.
          const pages = a.pages!;
          const bytes = await run(() => core.merge([{ bytes: f.bytes, pages: pages.map((p) => p - 1) }]), { file: a.input, op: "merge", pages });
          parts = [{ pages, bytes }];
        } else {
          const ranges =
            a.mode === "ranges"
              ? a.ranges!.map((r) => [r.from, r.to] as [number, number])
              : everyNRanges((await run(() => core.pdfInfo(f.bytes), { file: a.input, op: "info" })).pages, a.n!);
          parts = await run(() => core.split(f.bytes, ranges), { file: a.input, op: "split" });
        }
        const base = baseOf(a.input);
        const outputs: string[] = [];
        const files: { output: string; pages: number[] }[] = [];
        for (const [i, p] of parts.entries()) {
          const output = await writePdf(guard, outDir, splitPartBase(base, p.pages, i), p.bytes);
          outputs.push(output);
          files.push({ output, pages: p.pages });
        }
        return ok(`Wrote ${outputs.length} file(s):\n${outputs.join("\n")}`, { outputs, files });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "pdf_organize",
    {
      title: "Reorder, rotate or delete PDF pages",
      description: `Reorder, rotate and/or remove pages of a local PDF and save the result as a new file. Page numbers are 1-based and always refer to the ORIGINAL document. order is the final page sequence (pages not listed are removed); pages may be repeated to duplicate them; rotate adds any multiple of 90 degrees clockwise; delete is a shortcut for "all pages except these". ${local}`,
      inputSchema: pdfOrganizeSchema,
      annotations: { ...writeAnn, title: "Organize PDF pages" },
    },
    async (a) => {
      try {
        const bad = organizeArgsError(a);
        if (bad) throw new UserError(bad, "BAD_ARGS");
        const base = outputBase(a.outputName, `${baseOf(a.input)}-organized`);
        const [f] = await readInputs(guard, [a.input], "pdf");
        const outDir = await guard.resolveOutputDir(a.outputDir);
        const pageCount = organizeNeedsPageCount(a) ? (await run(() => core.pdfInfo(f.bytes), { file: a.input, op: "info" })).pages : undefined;
        const ops = toOrganizeOps(a, pageCount);
        const bytes = await run(() => core.organize(f.bytes, ops), { file: a.input, op: "organize" });
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
      description: `Combine 1-${LIMITS.MAX_FILES} local JPEG/PNG images into one PDF, one image per page (EXIF orientation applied). pageSize fit (default) makes each page the size of its image; A4 or Letter scales each image to fit a portrait page, centered; marginMm adds a margin. The type is detected from the file contents. EXIF, GPS and other metadata are removed. Max ${LIMITS.MAX_IMAGE_PIXELS / 1e6} MP per image. ${local}`,
      inputSchema: imagesToPdfSchema,
      annotations: { ...writeAnn, title: "Images to PDF" },
    },
    async (a) => {
      try {
        const base = outputBase(a.outputName, "images");
        const files = await readInputs(guard, a.images, "image");
        const outDir = await guard.resolveOutputDir(a.outputDir);
        const bytes = await run(() => core.imagesToPdf(files.map((f) => ({ bytes: f.bytes })), imageOptions(a)), { files: a.images, op: "images" });
        const output = await writePdf(guard, outDir, base, bytes);
        return ok(`Created ${output} from ${files.length} image(s).`, { output, bytes: bytes.byteLength });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}
