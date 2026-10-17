import { z } from "zod";

const path = z.string().min(1);
const pageNo = z.number().int().min(1);

export const pdfInfoSchema = {
  input: path.describe("PDF path relative to the allowed root. Example: docs/contract.pdf"),
};

export const pdfMergeSchema = {
  inputs: z.array(path).min(2).describe("PDF paths in the order they should appear (2-50 files)."),
  outputDir: path.describe("Directory for the result, relative to the allowed root. Created if missing."),
  outputName: z.string().optional().describe('File name without path, e.g. "merged" (default). Never overwrites: a free name like merged-1.pdf is chosen.'),
};

const range = z
  .object({ from: pageNo, to: pageNo })
  .refine((r) => r.from <= r.to, { message: "from must be <= to" });

export const pdfSplitSchema = {
  input: path.describe("PDF path relative to the allowed root."),
  mode: z.enum(["ranges", "every_n", "extract"]).describe("ranges: one file per range; every_n: chunks of n pages; extract: one file with the listed pages."),
  ranges: z.array(range).min(1).optional().describe('For mode=ranges: 1-based inclusive ranges, e.g. [{"from":1,"to":3},{"from":5,"to":5}].'),
  n: z.number().int().min(1).optional().describe("For mode=every_n: pages per output file."),
  pages: z.array(pageNo).min(1).optional().describe("For mode=extract: 1-based page numbers, in output order."),
  outputDir: path.describe("Directory for the results, relative to the allowed root."),
};

export const pdfOrganizeSchema = {
  input: path.describe("PDF path relative to the allowed root."),
  order: z.array(pageNo).min(1).optional().describe("New page order as 1-based input page numbers, e.g. [3,1,2]."),
  rotate: z
    .record(z.string().regex(/^[1-9][0-9]*$/), z.union([z.literal(90), z.literal(180), z.literal(270)]))
    .optional()
    .describe('Clockwise rotation per page, e.g. {"2":90}.'),
  delete: z.array(pageNo).min(1).optional().describe("1-based page numbers to remove."),
  outputDir: path.describe("Directory for the result, relative to the allowed root."),
  outputName: z.string().optional().describe("File name without path (default: <input>-organized)."),
};

export const imagesToPdfSchema = {
  images: z.array(path).min(1).describe("JPEG or PNG paths in page order (1-50). EXIF/GPS and other metadata are removed."),
  pageSize: z.enum(["a4", "letter", "fit"]).default("a4").describe("a4, letter, or fit (page = image size)."),
  marginMm: z.number().min(0).max(50).default(0).describe("Page margin in millimetres (0-50)."),
  outputDir: path.describe("Directory for the result, relative to the allowed root."),
  outputName: z.string().optional().describe('File name without path (default: "images").'),
};

/** Cross-field checks for pdf_split that a flat object schema cannot express. Returns an error message or null. */
export function splitArgsError(a: { mode: string; ranges?: unknown[]; n?: number; pages?: unknown[] }): string | null {
  if (a.mode === "ranges" && !a.ranges) return "mode=ranges needs ranges.";
  if (a.mode === "every_n" && !a.n) return "mode=every_n needs n.";
  if (a.mode === "extract" && !a.pages) return "mode=extract needs pages.";
  return null;
}

export function organizeArgsError(a: { order?: unknown; rotate?: unknown; delete?: unknown }): string | null {
  return a.order || a.rotate || a.delete ? null : "Give at least one of order, rotate or delete.";
}
