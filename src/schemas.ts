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

/**
 * A clockwise rotation for one page. Any multiple of 90 (negative or above 360 too): the core adds it to the page's
 * current rotation and normalizes mod 360, so no normalization happens here.
 */
const rotation = z.object({
  page: pageNo.describe("1-based page number of the ORIGINAL document. Applies to every copy of that page in order."),
  degrees: z.number().int().multipleOf(90).describe("Clockwise degrees, any multiple of 90 (e.g. 90, 180, 270, -90, 450)."),
});

export const pdfOrganizeSchema = {
  input: path.describe("PDF path relative to the allowed root."),
  order: z
    .array(pageNo)
    .min(1)
    .optional()
    .describe(
      "Final page sequence as 1-based page numbers of the ORIGINAL document, e.g. [3,1,2]. Pages not listed are removed; " +
        "a page may be repeated to duplicate it, e.g. [1,1,2]. " +
        "May be omitted only together with delete and/or rotate: then all pages are kept in original order (minus delete).",
    ),
  rotate: z
    .array(rotation)
    .min(1)
    .optional()
    .describe('Rotations by ORIGINAL 1-based page number, e.g. [{"page":2,"degrees":90}]. Added to the current rotation; entries for the same page are summed.'),
  delete: z
    .array(pageNo)
    .min(1)
    .optional()
    .describe("Convenience: 1-based page numbers to remove, keeping the rest in original order. Cannot be combined with order (just leave those pages out of order)."),
  outputDir: path.describe("Directory for the result, relative to the allowed root."),
  outputName: z.string().optional().describe("File name without path (default: <input>-organized)."),
};

/** The core makes each page the size of its image (1 px = 1 pt, EXIF orientation applied); it has no page size or margin options. */
export const imagesToPdfSchema = {
  images: z
    .array(path)
    .min(1)
    .describe("JPEG or PNG paths in page order (1-50). The type is detected from the file contents. EXIF/GPS and other metadata are removed."),
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

export function organizeArgsError(a: { order?: unknown[]; rotate?: unknown[]; delete?: unknown[] }): string | null {
  if (a.order && a.delete) return "Use either order (the final page sequence; pages not listed are removed) or delete, not both.";
  if (!a.order && !a.rotate && !a.delete) return "Give order (final page sequence), and/or rotate, or delete.";
  return null;
}
