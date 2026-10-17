/**
 * Error codes of the core module (site + MCP).
 * TODO(core swap): re-export the core's list instead:
 *   export { ERROR_CODES as CORE_ERROR_CODES } from "@local-pdf-tools/core";
 */
export const CORE_ERROR_CODES = [
  "PDF_ENCRYPTED",
  "PDF_INVALID",
  "PAGE_RANGE",
  "TOO_LARGE",
  "TOO_MANY_PAGES",
  "TOO_MANY_FILES",
  "IMAGE_TOO_LARGE", // image over the megapixel limit (core checks it from the header)
  "IMAGE_INVALID", // broken/undecodable image
  "UNSUPPORTED_IMAGE", // not JPEG or PNG
  "NOT_IMPLEMENTED",
] as const;
export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];

export function isCoreErrorCode(code: unknown): code is CoreErrorCode {
  return typeof code === "string" && (CORE_ERROR_CODES as readonly string[]).includes(code);
}

/** An error whose message is safe and useful to show to the model/user. */
export class UserError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "UserError";
  }
}
