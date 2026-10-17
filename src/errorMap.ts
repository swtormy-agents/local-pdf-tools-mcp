import { isCoreErrorCode, UserError, type CoreErrorCode } from "./errors.js";
import { LIMITS } from "./limits.js";

const MB = 1024 * 1024;

/**
 * Turn a core failure into an actionable message for the model/user. Unknown errors are not leaked verbatim.
 * Core errors are recognised by a known `code` property (not by class), so the real core's error class works too.
 */
export function mapCoreError(e: unknown, file?: string): UserError {
  if (e instanceof UserError) return e;
  const where = file ? ` (${file})` : "";
  const code = (e as { code?: unknown } | null)?.code;
  if (!(e instanceof Error) || !isCoreErrorCode(code)) {
    return new UserError(`Unexpected error while processing the PDF${where}. The input may be damaged.`, "INTERNAL");
  }
  const msg: Record<CoreErrorCode, string> = {
    PDF_ENCRYPTED: `The PDF${where} is password-protected or encrypted. It is never decrypted here; remove the password in the app that created the file, then try again.`,
    PDF_INVALID: `The file${where} is not a valid PDF or is damaged. Re-export it from the original app.`,
    PAGE_RANGE: `Page numbers are out of range${where}: ${e.message} Use 1-based page numbers that exist in the document (see pdf_info), and keep at least one page.`,
    TOO_LARGE: `Input is too large${where}: max ${LIMITS.maxFileBytes / MB} MB per file and ${LIMITS.maxTotalBytes / MB} MB in total.`,
    TOO_MANY_PAGES: `The result would have more than ${LIMITS.maxResultPages} pages. Split the job into smaller parts.`,
    TOO_MANY_FILES: `Too many input files: max ${LIMITS.maxFiles} per call.`,
    IMAGE_TOO_LARGE: `Image${where} is larger than ${LIMITS.maxImageMegapixels} megapixels. Downscale it first.`,
    IMAGE_INVALID: `Image${where} is damaged or cannot be read. Re-save it as JPEG or PNG in an image editor and try again.`,
    UNSUPPORTED_IMAGE: `Image${where} is not a JPEG or PNG. Only JPEG and PNG are supported; convert it first (e.g. export as PNG).`,
    NOT_IMPLEMENTED: "This operation is not available yet in this version.",
  };
  return new UserError(msg[code], code);
}
