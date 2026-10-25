import { describe, expect, it } from "vitest";
import { winWriteFailedOk } from "./helpers";

describe("Windows WRITE_FAILED allowance (L1)", () => {
  it("accepts only EPERM/EACCES in the message, not ENOSPC/EIO", () => {
    expect(winWriteFailedOk('Could not write the output file in "o" (EPERM). Nothing was left behind.')).toBe(true);
    expect(winWriteFailedOk('Could not write the output file in "o" (EACCES). Nothing was left behind.')).toBe(true);
    expect(winWriteFailedOk('Could not write the output file in "o" (ENOSPC). Nothing was left behind.')).toBe(false);
    expect(winWriteFailedOk('Could not write the output file in "o" (EIO). Nothing was left behind.')).toBe(false);
    expect(winWriteFailedOk("Could not write the output file. Nothing was left behind.")).toBe(false);
  });
});
