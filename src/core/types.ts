/**
 * Contract of the shared, DOM-free PDF core `@local-pdf-tools/core`
 * (git dependency github:swtormy-agents/pdf-tools#<sha>, package at the repo root, ESM with types; owner: Ryan Foster).
 * Bytes and plain params in, bytes and plain data out. No fs, no DOM, no network.
 *
 * The core OWNS its constants: it exports `LIMITS` and `ERROR_CODES`; limits are not passed in and cannot be overridden.
 * Inside the core (the MCP layer must NOT duplicate these): the 1000-page result limit, metadata stripping,
 * /Annots cleanup, image header checks (IMAGE_TOO_LARGE / IMAGE_INVALID / UNSUPPORTED_IMAGE).
 * The MCP layer owns file access, the allowed root, the pre-read file size check (same LIMITS values),
 * output file naming and safe writes.
 *
 * Until the core is pushed these types mirror it by hand; on swap they should be replaced by the core's own types.
 */
import type { CoreErrorCode } from "../errors.js";

/** Stub-side error class. The real core's errors are recognised by their `code` (see errorMap.ts), not by this class. */
export class CoreError extends Error {
  constructor(public readonly code: CoreErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "CoreError";
  }
}

export interface PdfInfo {
  pageCount: number;
  /** Page sizes in PDF points, after /Rotate. */
  pages: { width: number; height: number; rotation: 0 | 90 | 180 | 270 }[];
  encrypted: boolean;
  pdfVersion?: string;
}

/** 1-based inclusive page range. */
export interface PageRange {
  from: number;
  to: number;
}

export type SplitSpec =
  | { mode: "ranges"; ranges: PageRange[] } // one output per range
  | { mode: "every_n"; n: number } // chunks of n pages
  | { mode: "extract"; pages: number[] }; // one output with these pages, in this order

/** One output of split. The MCP layer names the file (e.g. <base>-p1-3.pdf). */
export interface SplitPart {
  /** 1-based page numbers of the input that this part contains, in output order. */
  pages: number[];
  bytes: Uint8Array;
}

export interface OrganizeOps {
  /**
   * Final page sequence as 0-based indices of the ORIGINAL pages. Pages absent from `order` are deleted.
   * There is no separate delete. An empty order fails with PAGE_RANGE.
   */
  order: number[];
  /** Clockwise rotation keyed by 0-based ORIGINAL page index; multiples of 90, added to the page's current rotation. */
  rotate?: Record<number, number>;
}

export type PageSize = "a4" | "letter" | "fit";

export interface ImageInput {
  bytes: Uint8Array;
  type: "jpeg" | "png";
}

export interface ImagesToPdfOptions {
  pageSize: PageSize;
  marginMm: number;
}

export interface PdfCore {
  info(pdf: Uint8Array): Promise<PdfInfo>;
  merge(pdfs: Uint8Array[]): Promise<Uint8Array>;
  split(pdf: Uint8Array, spec: SplitSpec): Promise<SplitPart[]>;
  organize(pdf: Uint8Array, ops: OrganizeOps): Promise<Uint8Array>;
  /** Strips EXIF/GPS/XMP before embedding; never re-encodes. Checks image headers (size/validity/type). */
  imagesToPdf(images: ImageInput[], opts: ImagesToPdfOptions): Promise<Uint8Array>;
}
