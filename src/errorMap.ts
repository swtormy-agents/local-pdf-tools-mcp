import { isCoreErrorCode, UserError, type CoreErrorCode } from "./errors.js";
import { LIMITS } from "./limits.js";

const MB = 1024 * 1024;

/**
 * Turn a core failure into an actionable message for the model/user. Unknown errors are not leaked verbatim.
 * Core errors (PdfToolError) are recognised by a known `code` property, not by class, so a second copy of the core
 * (e.g. bundled vs. test import) still maps correctly.
 * `files` are the user-facing input names of a multi-file call: the core reports the failing item as `details.index`.
 */
export function mapCoreError(e: unknown, file?: string, files?: readonly string[]): UserError {
  if (e instanceof UserError) return e;
  const index = (e as { details?: { index?: unknown } } | null)?.details?.index;
  const name = file ?? (files && typeof index === "number" && Number.isInteger(index) ? files[index] : undefined);
  const where = name ? ` (${name})` : "";
  const code = (e as { code?: unknown } | null)?.code;
  if (!(e instanceof Error) || !isCoreErrorCode(code)) {
    return new UserError(`Unexpected error while processing the PDF${where}. The input may be damaged.`, "INTERNAL");
  }
  // The core's organize/merge messages use 0-based indexes or the core's `order` argument; never show those to a caller
  // that uses 1-based pages (and may have used `delete`).
  const pageDetail = /index|order must be/i.test(e.message) ? "a page number does not exist in the document, or the selection is empty" : e.message.replace(/\.$/, "");
  const msg: Record<CoreErrorCode, string> = {
    PDF_ENCRYPTED: `The PDF${where} is password-protected or encrypted. It is never decrypted here; remove the password in the app that created the file, then try again.`,
    PDF_INVALID: `The file${where} is not a valid PDF or is damaged. Re-export it from the original app.`,
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
