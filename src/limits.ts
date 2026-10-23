/**
 * Limits are owned by the core and cannot be overridden (same values as the website):
 * MAX_FILE_BYTES 100 MB, MAX_TOTAL_BYTES 300 MB, MAX_PAGES 1000 (result pages; each split part), MAX_SPLIT_TOTAL_PAGES 5000
 * and MAX_SPLIT_PARTS 50 (split), MAX_FILES 50, MAX_IMAGE_PIXELS 50 000 000 (from the image header),
 * MAX_DECOMPRESSED_BYTES 500 MB (PDF streams decompressed per call; TOO_LARGE with details.reason 'decompressed').
 * The MCP layer uses the same object only to pre-check file count/size before reading files.
 */
import { LIMITS } from "@local-pdf-tools/core";

export { LIMITS };
export type Limits = typeof LIMITS;
