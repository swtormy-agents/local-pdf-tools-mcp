import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPortablePath, isWindowsReserved, PathGuard, testHooks } from "../src/pathGuard";
import { tmpRoot } from "./helpers";

// Creating symlinks on Windows needs admin rights or Developer Mode, which CI runners do not guarantee.
const SYMLINKS = process.platform !== "win32";
const itSymlink = it.skipIf(!SYMLINKS);
let root: string;
let outside: string;
let guard: PathGuard;

beforeAll(async () => {
  const base = await tmpRoot();
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "sub", "a.png"), "x");
  await fs.writeFile(path.join(outside, "secret.png"), "x");
  if (SYMLINKS) {
    await fs.symlink(path.join(outside, "secret.png"), path.join(root, "link-out.png"));
    await fs.symlink(path.join(root, "sub", "a.png"), path.join(root, "link-in.png"));
    await fs.symlink(outside, path.join(root, "dir-out"));
  }
  guard = await PathGuard.create(root);
});

describe("PathGuard", () => {
  it("resolves relative and absolute paths inside the root", async () => {
    expect(await guard.resolveInputFile("sub/a.png")).toBe(path.join(root, "sub", "a.png"));
    expect(await guard.resolveInputFile(path.join(root, "sub", "a.png"))).toBe(path.join(root, "sub", "a.png"));
    expect(await guard.resolveInputFile("sub/../sub/a.png")).toBe(path.join(root, "sub", "a.png"));
  });

  it("rejects ../ traversal and absolute paths outside", async () => {
    await expect(guard.resolveInputFile("../outside/secret.png")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    await expect(guard.resolveInputFile(path.join(outside, "secret.png"))).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    await expect(guard.resolveInputFile("/etc/passwd")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    await expect(guard.resolveOutputDir("../outside")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
  });

  it("rejects a root-prefix sibling (root-evil)", async () => {
    await fs.mkdir(root + "-evil", { recursive: true });
    await expect(guard.resolveOutputDir(root + "-evil")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
  });

  itSymlink("rejects symlinks that point outside, allows ones inside (skipped on Windows: symlinks need privileges)", async () => {
    await expect(guard.resolveInputFile("link-out.png")).rejects.toMatchObject({ code: "SYMLINK_OUTSIDE_ROOT" });
    expect(await guard.resolveInputFile("link-in.png")).toBe(path.join(root, "sub", "a.png"));
    await expect(guard.resolveInputDir("dir-out")).rejects.toMatchObject({ code: "SYMLINK_OUTSIDE_ROOT" });
    await expect(guard.resolveOutputDir("dir-out/new")).rejects.toMatchObject({ code: "SYMLINK_OUTSIDE_ROOT" });
    await expect(fs.stat(path.join(outside, "new"))).rejects.toThrow();
  });

  it("creates missing output dirs inside the root", async () => {
    expect(await guard.resolveOutputDir("out/a/b")).toBe(path.join(root, "out", "a", "b"));
  });

  it("gives actionable errors for missing files and bad input", async () => {
    await expect(guard.resolveInputFile("nope.png")).rejects.toMatchObject({ code: "INPUT_NOT_FOUND" });
    await expect(guard.resolveInputFile("sub")).rejects.toMatchObject({ code: "INPUT_NOT_FILE" });
    await expect(guard.resolveInputFile("a\0b")).rejects.toMatchObject({ code: "PATH_INVALID" });
    await expect(guard.resolveInputFile("")).rejects.toMatchObject({ code: "PATH_EMPTY" });
  });

  it("refuses a missing root", async () => {
    await expect(PathGuard.create(path.join(root, "does-not-exist"))).rejects.toMatchObject({ code: "ROOT_MISSING" });
  });

  it("refuses a filesystem root as the allowed root", async () => {
    await expect(PathGuard.create(path.parse(root).root)).rejects.toMatchObject({ code: "ROOT_TOO_BROAD" });
  });

  it("rejects drive-relative paths, ADS and reserved Windows names", async () => {
    for (const bad of ["C:foo.png", "c:sub\\a.png", "sub/a.png:stream", "a.png::$DATA", "CON", "sub/nul.png", "x/COM1.tar.gz", "lpt9", "aux.", "Prn .jpg", "CONIN$", "conout$.txt", "sub/CONOUT$"]) {
      expect(() => assertPortablePath(bad), bad).toThrow();
    }
    for (const ok of ["sub/a.png", "C:\\photos\\a.png", "/tmp/a.png", "console.png", "com10.png", "my-con.png", "../x"]) {
      expect(() => assertPortablePath(ok), ok).not.toThrow();
    }
    expect(isWindowsReserved("con.txt")).toBe(true);
    expect(isWindowsReserved("cone.txt")).toBe(false);
    expect(isWindowsReserved("CONIN$")).toBe(true);
    expect(isWindowsReserved("conout$.log")).toBe(true);
    expect(isWindowsReserved("conin")).toBe(false);
    await expect(guard.resolveInputFile("sub/CON.png")).rejects.toMatchObject({ code: "PATH_RESERVED_NAME" });
    await expect(guard.resolveOutputDir("out:ads")).rejects.toMatchObject({ code: "PATH_INVALID" });
  });

  it("writeNewFile never overwrites and renames reserved base names", async () => {
    const dir = await guard.resolveOutputDir("w");
    const a = await guard.writeNewFile(dir, "x", "png", Buffer.from("1"));
    const b = await guard.writeNewFile(dir, "x", "png", Buffer.from("2"));
    expect([path.basename(a), path.basename(b)]).toEqual(["x.png", "x-1.png"]);
    expect(await fs.readFile(a, "utf8")).toBe("1");
    expect(path.basename(await guard.writeNewFile(dir, "nul", "png", Buffer.from("3")))).toBe("_nul.png");
  });
});

// Regression for a TOCTOU race: the output directory is swapped for a symlink to a folder outside the root
// while a (slow) conversion is running. Nothing may be written outside the root.
describe.skipIf(!SYMLINKS)("TOCTOU: output dir swapped for a symlink (skipped on Windows: symlinks need privileges)", () => {
  async function setup() {
    const base = await tmpRoot();
    const r = path.join(base, "root");
    const out = path.join(base, "outside");
    await fs.mkdir(path.join(r, "out"), { recursive: true });
    await fs.mkdir(out);
    const g = await PathGuard.create(r);
    const dir = await g.resolveOutputDir("out");
    const swap = async () => {
      await fs.rename(dir, path.join(r, "out-moved"));
      await fs.symlink(out, dir);
    };
    return { g, dir, out, swap };
  }

  it("detects a swap during the conversion (before the write)", async () => {
    const { g, dir, out, swap } = await setup();
    testHooks.beforeWrite = swap;
    try {
      await expect(g.writeNewFile(dir, "img", "png", Buffer.from("data"))).rejects.toMatchObject({ code: "OUTPUT_DIR_CHANGED" });
    } finally {
      testHooks.beforeWrite = undefined;
    }
    expect(await fs.readdir(out)).toEqual([]);
  });

  it("never deletes by path if the swap happens between the check and open(): empties the stray file and reports it", async () => {
    const { g, dir, out, swap } = await setup();
    const victim = path.join(out, "keep.png");
    await fs.writeFile(victim, "VICTIM");
    testHooks.beforeOpen = swap;
    let err: any;
    try {
      await g.writeNewFile(dir, "img", "png", Buffer.from("data"));
    } catch (e) {
      err = e;
    } finally {
      testHooks.beforeOpen = undefined;
    }
    expect(err?.code).toBe("OUTPUT_DIR_CHANGED_FILE_LEFT");
    expect(err.message).not.toMatch(/was removed/);
    expect(await fs.readFile(victim, "utf8")).toBe("VICTIM");
    // The stray file outside the root holds no data.
    expect((await fs.stat(path.join(out, "img.png"))).size).toBe(0);
    if (process.platform === "linux") expect(err.message).toContain(path.join(out, "img.png"));
  });

  it("reports honestly when the dir is swapped back right after open()", async () => {
    const { g, dir, out, swap } = await setup();
    const moved = path.join(path.dirname(dir), "out-moved");
    testHooks.beforeOpen = swap;
    testHooks.afterOpen = async () => {
      await fs.unlink(dir);
      await fs.rename(moved, dir);
    };
    let err: any;
    try {
      await g.writeNewFile(dir, "img", "png", Buffer.from("data"));
    } catch (e) {
      err = e;
    } finally {
      testHooks.beforeOpen = undefined;
      testHooks.afterOpen = undefined;
    }
    expect(err?.code).toBe("OUTPUT_DIR_CHANGED_FILE_LEFT");
    expect(err.message).not.toMatch(/was removed/);
    expect(await fs.readdir(out)).toEqual(["img.png"]);
    expect((await fs.stat(path.join(out, "img.png"))).size).toBe(0);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("leaves an empty file (no partial data, no unlink) when the write fails", async () => {
    const { g, dir } = await setup();
    let err: any;
    try {
      await g.writeNewFile(dir, "img", "png", async (fh) => {
        await fh.write(Buffer.from("partial"));
        throw new Error("boom");
      });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("WRITE_FAILED_FILE_LEFT");
    expect(err.message).toMatch(/boom/);
    expect(err.message).toContain(path.join(dir, "img.png"));
    expect((await fs.stat(path.join(dir, "img.png"))).size).toBe(0);
  });

  it("never touches a file outside the root when the dir is swapped during failure handling", async () => {
    const { g, dir, out } = await setup();
    const moved = path.join(path.dirname(dir), "out-moved");
    const victim = path.join(out, "img.png");
    await fs.writeFile(victim, "VICTIM DATA");
    testHooks.beforeCleanup = async () => {
      await fs.rename(dir, moved);
      await fs.symlink(out, dir);
    };
    let err: any;
    try {
      await g.writeNewFile(dir, "img", "png", async (fh) => {
        await fh.write(Buffer.from("partial"));
        throw new Error("boom");
      });
    } catch (e) {
      err = e;
    } finally {
      testHooks.beforeCleanup = undefined;
    }
    expect(err?.code).toBe("WRITE_FAILED_FILE_LEFT");
    expect(await fs.readFile(victim, "utf8")).toBe("VICTIM DATA");
    expect((await fs.stat(path.join(moved, "img.png"))).size).toBe(0);
  });
});
