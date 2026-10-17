/** Error codes shared with the core module (site + MCP). */
export const CORE_ERROR_CODES = [
  "PDF_ENCRYPTED",
  "PDF_INVALID",
  "PAGE_RANGE",
  "TOO_LARGE",
  "TOO_MANY_PAGES",
  "TOO_MANY_FILES",
  "IMAGE_TOO_LARGE", // provisional name for the 50 MP image pixel limit (pending agreement with the core owner)
  "NOT_IMPLEMENTED",
] as const;
export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];

/** An error whose message is safe and useful to show to the model/user. */
export class UserError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "UserError";
  }
}
