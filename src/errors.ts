/** Error codes of the core module (site + MCP), re-exported from the core so the lists cannot drift. */
import { ERROR_CODES, type ErrorCode } from "@local-pdf-tools/core";

export const CORE_ERROR_CODES: readonly ErrorCode[] = ERROR_CODES;
export type CoreErrorCode = ErrorCode;
export { PdfToolError } from "@local-pdf-tools/core";

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
