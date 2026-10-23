/**
 * B2 on macOS Node 20 hit FS_TIMEOUT: the server joined ALL received pipe chunks on every chunk while a large file
 * read came back from the helper (quadratic copying: ~3 s per 39 MB input, 23 s for the four B2 calls vs ~8 s now).
 * The frame is now joined once, when it is complete. Asserted structurally (number of Buffer.concat calls), not by time.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PathGuard } from "../src/pathGuard";
import { tmpRoot } from "./helpers";

describe("helper channel: large reads are joined once", () => {
  it("a 40 MB read does not re-join the buffer per pipe chunk", async () => {
    const root = await tmpRoot();
    const big = Buffer.alloc(40 * 1024 * 1024, 0x41);
    big.write("%PDF-1.7\n");
    await fs.writeFile(path.join(root, "big.pdf"), big);
    const guard = await PathGuard.create(root);
    await guard.readInputFile("big.pdf", 100 * 1024 * 1024); // warm the helper
    const spy = vi.spyOn(Buffer, "concat");
    try {
      const r = await guard.readInputFile("big.pdf", 100 * 1024 * 1024);
      expect(Buffer.from(r.bytes!).equals(big)).toBe(true);
      const big2 = spy.mock.calls.filter(([list]) => (list as Buffer[]).reduce((a, b) => a + b.length, 0) > 1024 * 1024).length;
      expect(big2, `Buffer.concat calls over 1 MiB: ${big2}`).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});

describe("output names: no linear re-probe per write", () => {
  it("the 300th write of the same name announces one name, not 300 (Windows folderMoves 20k slowdown)", async () => {
    const { testHooks } = await import("../src/pathGuard");
    const root = await tmpRoot();
    await fs.mkdir(path.join(root, "o"));
    const guard = await PathGuard.create(root);
    const dir = await guard.resolveOutputDir("o");
    for (let k = 0; k < 299; k++) await guard.writeNewFile(dir, "x", "pdf", Buffer.from("%PDF-1.7"));
    // A file created by someone else at the next number is still never overwritten (O_EXCL decides).
    await fs.writeFile(path.join(root, "o", "x-299.pdf"), "FOREIGN");
    const announced: string[] = [];
    testHooks.onWriteProgress = (h) => { if (!h.created && h.name) announced.push(h.name); };
    try {
      const name = await guard.writeNewFile(dir, "x", "pdf", Buffer.from("%PDF-1.7"));
      expect(path.basename(name)).toBe("x-300.pdf");
    } finally {
      testHooks.onWriteProgress = undefined;
    }
    expect(announced).toEqual(["x-300.pdf"]);
    expect(await fs.readFile(path.join(root, "o", "x-299.pdf"), "utf8")).toBe("FOREIGN");
    expect((await fs.readdir(path.join(root, "o"))).length).toBe(301);
  }, 60_000);
});
