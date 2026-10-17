/**
 * Contract of the shared, DOM-free PDF core (built on pdf-lib, owned by the website team).
 * Bytes and plain params in, bytes and plain data out. No fs, no DOM, no network.
 * Failures throw CoreError with one of CORE_ERROR_CODES.
 * The MCP layer owns file access, the allowed root, limits on inputs and safe writes.
 */
import type { CoreErrorCode } from "../errors.js";
import type { Limits } from "../limits.js";

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

export interface OrganizeOps {
  /** New order as 1-based page numbers of the input (after deletions are ignored). Omit to keep order. */
  order?: number[];
  /** Clockwise rotation added per 1-based page number. */
  rotate?: Record<number, 90 | 180 | 270>;
  /** 1-based page numbers to drop. */
  delete?: number[];
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
  info(pdf: Uint8Array, limits: Limits): Promise<PdfInfo>;
  merge(pdfs: Uint8Array[], limits: Limits): Promise<Uint8Array>;
  split(pdf: Uint8Array, spec: SplitSpec, limits: Limits): Promise<Uint8Array[]>;
  organize(pdf: Uint8Array, ops: OrganizeOps, limits: Limits): Promise<Uint8Array>;
  /** Strips EXIF/GPS/XMP before embedding; never re-encodes. */
  imagesToPdf(images: ImageInput[], opts: ImagesToPdfOptions, limits: Limits): Promise<Uint8Array>;
}
