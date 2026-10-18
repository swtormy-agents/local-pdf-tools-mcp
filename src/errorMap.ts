import { isCoreErrorCode, UserError, type CoreErrorCode } from "./errors.js";
import { LIMITS } from "./limits.js";

const MB = 1024 * 1024;
/** Upper bound of images_to_pdf marginMm (schemas.ts); always below the core's limit (half the shorter A4 side). */
export const MAX_MARGIN_MM = 50;

/** Which core call failed. It decides what `details.index` means (organize: position in `order`; merge: input item). */
export type CoreOp = "info" | "merge" | "split" | "organize" | "images";

/** Optional context of a core call, used to name the failing input and to phrase PAGE_RANGE in 1-based words. */
export interface ErrorContext {
  /** User-facing name of the single input. */
  file?: string;
  /** User-facing names of the inputs of a multi-file call (merge / images): the core reports the item as `details.index`. */
  files?: readonly string[];
  op?: CoreOp;
  /**
   * For `pdf_split` mode=extract (a one-item core merge): the 1-based page numbers the caller passed, so a bad entry
   * is reported with the caller's own value.
   */
  pages?: readonly number[];
}

type Details = {
  index?: unknown;
  position?: unknown;
  page?: unknown;
  pageCount?: unknown;
  from?: unknown;
  to?: unknown;
  degrees?: unknown;
  option?: unknown;
};

const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const pagesOf = (n: number) => `${n} page${n === 1 ? "" : "s"}`;

/**
 * PAGE_RANGE in 1-based words, built from the core's structured `details` (never from its message, which uses
 * 0-based indexes and the core's own argument names). Returns null when the details have no known shape.
 */
export function pageRangeDetail(d: Details | undefined, ctx: ErrorContext = {}): string | null {
  if (!d) return null;
  const has = int(d.pageCount) ? ` (the document has ${pagesOf(d.pageCount)})` : "";
  if (ctx.op === "organize") {
    // Bad order entry: index = 0-based position in order, page = 0-based ORIGINAL index (null if not a number).
    if (int(d.index) && "page" in d) {
      return int(d.page) ? `page ${d.page + 1} (position ${d.index + 1} in order) does not exist${has}` : `position ${d.index + 1} in order is not a page number${has}`;
    }
    if ("degrees" in d) return `the rotation${int(d.page) ? ` of page ${d.page + 1}` : ""} must be a multiple of 90 degrees`;
    if ("page" in d) return int(d.page) ? `page ${d.page + 1} in rotate does not exist${has}` : `a page in rotate is not a page number${has}`;
    if (int(d.pageCount)) return `no pages would be left${has}; keep at least one page`;
    return null;
  }
  if (ctx.op === "merge") {
    // index = input item (named by the caller via `where`); position = 0-based position in that item's pages.
    if (int(d.position)) {
      const given = ctx.pages?.[d.position];
      const page = given ?? (int(d.page) ? d.page + 1 : undefined);
      return page !== undefined ? `page ${page} (position ${d.position + 1} in pages) does not exist${has}` : `position ${d.position + 1} in pages is not a page number${has}`;
    }
    if (int(d.from) && int(d.to)) return `pages ${d.from}-${d.to} are outside the document${has}`;
    if (int(d.pageCount)) return `the page selection is empty${has}`;
    return null;
  }
  if (ctx.op === "split") {
    if (int(d.from) && int(d.to)) return int(d.pageCount) ? `range ${d.from}-${d.to} is outside the document${has}` : `range ${d.from}-${d.to} is reversed`;
    return null;
  }
  return null;
}

/**
 * Turn a core failure into an actionable message for the model/user. Unknown errors are not leaked verbatim.
 * Core errors (PdfToolError) are recognised by a known `code` property, not by class, so a second copy of the core
 * (e.g. bundled vs. test import) still maps correctly.
 */
export function mapCoreError(e: unknown, ctx: ErrorContext = {}): UserError {
  if (e instanceof UserError) return e;
  const details = (e as { details?: Details } | null)?.details;
  const index = details?.index;
  // In organize, details.index is a position in `order`, not an input item.
  const itemName = ctx.op !== "organize" && ctx.files && int(index) ? ctx.files[index] : undefined;
  const name = ctx.file ?? itemName;
  const where = name ? ` (${name})` : "";
  const code = (e as { code?: unknown } | null)?.code;
  if (!(e instanceof Error) || !isCoreErrorCode(code)) {
    return new UserError(`Unexpected error while processing the PDF${where}. The input may be damaged.`, "INTERNAL");
  }
  const pageDetail = (code === "PAGE_RANGE" && pageRangeDetail(details, ctx)) || "a page number does not exist in the document, or the selection is empty";
  const msg: Record<CoreErrorCode, string> = {
    PDF_ENCRYPTED: `The PDF${where} is password-protected or encrypted. It is never decrypted here; remove the password in the app that created the file, then try again.`,
    PDF_INVALID:
      details?.option === "pageSize" || details?.option === "margin"
        ? `Invalid images_to_pdf ${details.option === "margin" ? "marginMm" : "pageSize"}: pageSize must be fit, A4 or Letter; marginMm must be 0-${MAX_MARGIN_MM}.`
        : `The file${where} is not a valid PDF or is damaged. Re-export it from the original app.`,
    PAGE_RANGE: `Page numbers are out of range${where}: ${pageDetail}. Use 1-based page numbers that exist in the document (see pdf_info), and keep at least one page.`,
    TOO_LARGE: `Input is too large${where}: max ${LIMITS.MAX_FILE_BYTES / MB} MB per file and ${LIMITS.MAX_TOTAL_BYTES / MB} MB in total.`,
    TOO_MANY_PAGES: `The result would have more than ${LIMITS.MAX_PAGES} pages. Split the job into smaller parts.`,
    TOO_MANY_FILES: `Too many input files: max ${LIMITS.MAX_FILES} per call.`,
    IMAGE_TOO_LARGE: `Image${where} is larger than ${LIMITS.MAX_IMAGE_PIXELS / 1e6} megapixels. Downscale it first.`,
    IMAGE_INVALID: `Image${where} is damaged or cannot be read. Re-save it as JPEG or PNG in an image editor and try again.`,
    UNSUPPORTED_IMAGE: `Image${where} is not a JPEG or PNG (detected from the file contents, not the extension). Only JPEG and PNG are supported; convert it first (e.g. export as PNG).`,
  };
  return new UserError(msg[code], code);
}
