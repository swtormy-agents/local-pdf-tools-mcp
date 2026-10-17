/** Shared limits (same values as the website). Keep in sync with the core module's constants. */
export interface Limits {
  /** Maximum size of one input file in bytes. */
  maxFileBytes: number;
  /** Maximum total size of all inputs of one call in bytes. */
  maxTotalBytes: number;
  /** Maximum number of pages in a result document. */
  maxResultPages: number;
  /** Maximum number of input files in one call. */
  maxFiles: number;
  /** Maximum decoded image size in megapixels (images_to_pdf). */
  maxImageMegapixels: number;
}

const MB = 1024 * 1024;

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxFileBytes: 100 * MB,
  maxTotalBytes: 300 * MB,
  maxResultPages: 1000,
  maxFiles: 50,
  maxImageMegapixels: 50,
});
