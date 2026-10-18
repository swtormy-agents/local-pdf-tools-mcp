/**
 * Limits are owned by the core and cannot be overridden (same values as the website):
 * MAX_FILE_BYTES 100 MB, MAX_TOTAL_BYTES 300 MB, MAX_PAGES 1000 (result pages), MAX_FILES 50,
 * MAX_IMAGE_PIXELS 50 000 000 (from the image header).
 * The MCP layer uses the same object only to pre-check file count/size before reading files.
 */
import { LIMITS } from "@local-pdf-tools/core";

export { LIMITS };
export type Limits = typeof LIMITS;
