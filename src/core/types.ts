/**
 * Contract of the shared, DOM-free PDF core `@local-pdf-tools/core` (owner: Ryan Foster), taken from the core's own
 * type declarations. Bytes and plain params in, bytes and plain data out. No fs, no DOM, no network.
 *
 * The core OWNS its constants (`LIMITS`, `ERROR_CODES`) and everything about document content: the 1000-page result
 * limit, metadata/JavaScript/attachment/form stripping, /Annots cleanup (only http/https/mailto URI links survive),
 * JPEG APP1/APP13/COM stripping, image type detection by signature and header checks (IMAGE_TOO_LARGE /
 * IMAGE_INVALID / UNSUPPORTED_IMAGE), rotation normalization and repeated pages in `organize`.
 * The MCP layer owns file access, the allowed root, the pre-read file count/size check (same LIMITS values),
 * 1-based tool arguments, output file naming and safe writes.
 */
import type { imagesToPdf, merge, organize, pdfInfo, split } from "@local-pdf-tools/core";

export type {
  ErrorCode,
  ImageInput,
  MergeInput,
  OrganizeOps,
  PdfInfo,
  RangeSpec,
  SplitPart,
} from "@local-pdf-tools/core";

/** The subset of the core used by the server. Injectable so tests can observe or fake calls. */
export interface PdfCore {
  pdfInfo: typeof pdfInfo;
  merge: typeof merge;
  split: typeof split;
  organize: typeof organize;
  imagesToPdf: typeof imagesToPdf;
}
