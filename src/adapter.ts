/**
 * Pure conversions between the MCP tool arguments (user-facing, 1-based page numbers) and the core contract.
 * No limits, metadata, rotation normalization or annotation handling here: those belong to the core.
 */
import type { OrganizeOps } from "./core/types.js";
import { UserError } from "./errors.js";

export interface OrganizeArgs {
  order?: number[];
  rotate?: { page: number; degrees: number }[];
  delete?: number[];
}

/** pdf_organize needs the page count (one core.pdfInfo call) only when order is omitted. */
export function organizeNeedsPageCount(a: OrganizeArgs): boolean {
  return !a.order;
}

/**
 * Convert 1-based MCP arguments to the core's 0-based OrganizeOps (indices of ORIGINAL pages).
 * order is passed through as-is (repeats allowed; the core validates indices and the page limit).
 * order omitted => all pages in original order minus `delete`. An empty result is passed on; the core answers PAGE_RANGE.
 * rotate degrees are passed through unchanged (any multiple of 90; the core adds them and normalizes mod 360).
 * Several rotate entries for the same page are summed. Validate first with organizeArgsError (schemas.ts).
 */
export function toOrganizeOps(a: OrganizeArgs, pageCount?: number): OrganizeOps {
  let order: number[];
  if (a.order) {
    order = a.order.map((p) => p - 1);
  } else {
    if (pageCount === undefined) throw new Error("pageCount is required when order is omitted");
    const del = new Set(a.delete ?? []);
    const missing = [...del].filter((p) => p > pageCount);
    if (missing.length) {
      throw new UserError(`Page(s) ${missing.join(", ")} do not exist: the document has ${pageCount} page(s). Use 1-based page numbers (see pdf_info).`, "PAGE_RANGE");
    }
    order = Array.from({ length: pageCount }, (_, i) => i).filter((i) => !del.has(i + 1));
  }
  const ops: OrganizeOps = { order };
  if (a.rotate) {
    const rotate: Record<number, number> = {};
    for (const r of a.rotate) rotate[r.page - 1] = (rotate[r.page - 1] ?? 0) + r.degrees;
    ops.rotate = rotate;
  }
  return ops;
}

/** 1-based inclusive [from, to] ranges of n pages each, covering the whole document (pdf_split mode=every_n). */
export function everyNRanges(pageCount: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let from = 1; from <= pageCount; from += n) out.push([from, Math.min(from + n - 1, pageCount)]);
  return out;
}

/** "p1-3", "p5", "p1-3_5_7-8" from 1-based page numbers (runs of consecutive ascending pages are collapsed). */
export function pagesLabel(pages: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    runs.push(j > i ? `${pages[i]}-${pages[j]}` : `${pages[i]}`);
    i = j + 1;
  }
  return `p${runs.join("_")}`;
}

/** Output base name for one split part: <base>-p1-3; falls back to <base>-part<N> for empty or very long page lists. */
export function splitPartBase(base: string, pages: number[], index: number): string {
  const label = pages.length ? pagesLabel(pages) : "";
  return label && label.length <= 60 ? `${base}-${label}` : `${base}-part${index + 1}`;
}
