import { describe, expect, it } from "vitest";
import { organizeNeedsPageCount, pagesLabel, splitPartBase, toOrganizeOps } from "../src/adapter";

describe("organize adapter (1-based MCP args -> 0-based core ops on ORIGINAL pages)", () => {
  it("converts order and rotate to 0-based", () => {
    expect(toOrganizeOps({ order: [3, 1, 2] })).toEqual({ order: [2, 0, 1] });
    expect(toOrganizeOps({ order: [2], rotate: [{ page: 2, degrees: 90 }, { page: 5, degrees: -90 }] })).toEqual({ order: [1], rotate: { 1: 90, 4: -90 } });
    expect(organizeNeedsPageCount({ order: [1] })).toBe(false);
  });
  it("delete convenience: all pages minus delete, in original order", () => {
    expect(organizeNeedsPageCount({ delete: [2] })).toBe(true);
    expect(toOrganizeOps({ delete: [2] }, 4)).toEqual({ order: [0, 2, 3] });
    expect(toOrganizeOps({ delete: [1, 3], rotate: [{ page: 2, degrees: 180 }] }, 3)).toEqual({ order: [1], rotate: { 1: 180 } });
  });
  it("rotate only keeps all pages", () => {
    expect(toOrganizeOps({ rotate: [{ page: 1, degrees: 90 }] }, 3)).toEqual({ order: [0, 1, 2], rotate: { 0: 90 } });
  });
  it("deleting everything yields an empty order (the core answers PAGE_RANGE); unknown pages fail here", () => {
    expect(toOrganizeOps({ delete: [1, 2] }, 2)).toEqual({ order: [] });
    expect(() => toOrganizeOps({ delete: [4] }, 3)).toThrow(expect.objectContaining({ code: "PAGE_RANGE" }));
  });
});

describe("split part names", () => {
  it("labels pages as runs", () => {
    expect(pagesLabel([1, 2, 3])).toBe("p1-3");
    expect(pagesLabel([5])).toBe("p5");
    expect(pagesLabel([1, 2, 3, 5, 7, 8])).toBe("p1-3_5_7-8");
    expect(pagesLabel([3, 2, 1])).toBe("p3_2_1");
  });
  it("names outputs <base>-p..., with a fallback for empty/long lists", () => {
    expect(splitPartBase("report", [1, 2, 3], 0)).toBe("report-p1-3");
    expect(splitPartBase("report", [], 1)).toBe("report-part2");
    expect(splitPartBase("report", Array.from({ length: 40 }, (_, i) => i * 2 + 1), 2)).toBe("report-part3");
  });
});
