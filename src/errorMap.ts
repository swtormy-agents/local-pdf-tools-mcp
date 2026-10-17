import { CoreError } from "./core/types.js";
import { UserError } from "./errors.js";
import type { Limits } from "./limits.js";

const MB = 1024 * 1024;

/** Turn a core failure into an actionable message for the model/user. Unknown errors are not leaked verbatim. */
export function mapCoreError(e: unknown, limits: Limits, file?: string): UserError {
  if (e instanceof UserError) return e;
  const where = file ? ` (${file})` : "";
  if (!(e instanceof CoreError)) {
    return new UserError(`Unexpected error while processing the PDF${where}. The input may be damaged.`, "INTERNAL");
  }
  const msg: Record<string, string> = {
    PDF_ENCRYPTED: `The PDF${where} is password-protected or encrypted. It is never decrypted here; remove the password in the app that created the file, then try again.`,
    PDF_INVALID: `The file${where} is not a valid PDF or is damaged. Re-export it from the original app.`,
    PAGE_RANGE: `Page numbers are out of range${where}: ${e.message} Use 1-based page numbers that exist in the document (see pdf_info).`,
    TOO_LARGE: `Input is too large${where}: max ${limits.maxFileBytes / MB} MB per file and ${limits.maxTotalBytes / MB} MB in total.`,
    TOO_MANY_PAGES: `The result would have more than ${limits.maxResultPages} pages. Split the job into smaller parts.`,
    TOO_MANY_FILES: `Too many input files: max ${limits.maxFiles} per call.`,
    IMAGE_TOO_LARGE: `Image${where} is larger than ${limits.maxImageMegapixels} megapixels. Downscale it first.`,
    NOT_IMPLEMENTED: "This operation is not available yet in this version.",
  };
  return new UserError(msg[e.code] ?? e.message, e.code);
}
