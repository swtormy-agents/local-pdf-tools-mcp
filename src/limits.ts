/**
 * Limits are owned by the core (`LIMITS` exported by @local-pdf-tools/core) and cannot be overridden.
 * The MCP layer uses the same values only to pre-check file count/size before reading files.
 *
 * TODO(core swap): replace this whole file with
 *   export { LIMITS } from "@local-pdf-tools/core";
 *   export type Limits = typeof LIMITS;
 * The values below are the agreed ones, kept here only while the core is a stub.
 */
const MB = 1024 * 1024;

export const LIMITS = Object.freeze({
  /** Maximum size of one input file in bytes. */
  maxFileBytes: 100 * MB,
  /** Maximum total size of all inputs of one call in bytes. */
  maxTotalBytes: 300 * MB,
  /** Maximum number of pages in a result document (enforced by the core only). */
  maxResultPages: 1000,
  /** Maximum number of input files in one call. */
  maxFiles: 50,
  /** Maximum image size in megapixels (enforced by the core from the image header). */
  maxImageMegapixels: 50,
});

export type Limits = typeof LIMITS;
