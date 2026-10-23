import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPortablePath, isWindowsReserved, PathGuard, testHooks } from "../src/pathGuard";
import { canSymlink, DIRLINK, tmpRoot } from "./helpers";

// QA F8: directory-link races always run (junctions on Windows need no privilege); file-symlink cases run when a
// runtime probe can create a symlink (skipped only on EPERM).
const SYMLINKS = true;
const FILE_SYMLINKS = await canSymlink();
const itSymlink = it.skipIf(!FILE_SYMLINKS);
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
  if (FILE_SYMLINKS) {
    await fs.symlink(path.join(outside, "secret.png"), path.join(root, "link-out.png"));
    await fs.symlink(path.join(root, "sub", "a.png"), path.join(root, "link-in.png"));
  }
  {
    await fs.symlink(outside, path.join(root, "dir-out"), DIRLINK);
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

  itSymlink("rejects file symlinks that point outside, allows ones inside (skipped only if symlink creation fails with EPERM)", async () => {
    await expect(guard.resolveInputFile("link-out.png")).rejects.toMatchObject({ code: "SYMLINK_OUTSIDE_ROOT" });
    expect(await guard.resolveInputFile("link-in.png")).toBe(path.join(root, "sub", "a.png"));
  });

  it("rejects a directory link (junction on Windows) pointing outside", async () => {
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
describe.skipIf(!SYMLINKS)("TOCTOU: output dir swapped for a symlink (junctions on Windows)", () => {
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
      await fs.symlink(out, dir, DIRLINK);
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

  it("swap between the check and open(): nothing is created outside the root, nothing deleted (fix/input-race)", async () => {
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
    // The file is created relative to the directory actually entered, so the swapped-in symlink is detected before
    // anything is created outside the root.
    expect(err?.code).toBe("OUTPUT_DIR_CHANGED");
    expect(await fs.readFile(victim, "utf8")).toBe("VICTIM");
    expect(await fs.readdir(out)).toEqual(["keep.png"]);
  });

  it("swap before open() and back right after it: still nothing created outside the root", async () => {
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
    expect(err?.code).toBe("OUTPUT_DIR_CHANGED");
    expect(await fs.readdir(out)).toEqual([]);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("a failing producer creates nothing (no partial or empty file left)", async () => {
    const { g, dir, out } = await setup();
    const err: any = await g
      .writeNewFile(dir, "img", "png", async () => {
        throw new Error("boom");
      })
      .catch((e) => e);
    expect(err?.code).toBe("WRITE_FAILED");
    expect(err.message).toMatch(/boom/);
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await fs.readdir(out)).toEqual([]);
  });

  it("error messages name only root-relative paths (QA F6)", async () => {
    const { g, dir, out, swap } = await setup();
    testHooks.beforeOpen = swap;
    const err: any = await g.writeNewFile(dir, "img", "png", Buffer.from("data")).catch((e) => e);
    testHooks.beforeOpen = undefined;
    expect(err?.code).toBe("OUTPUT_DIR_CHANGED");
    expect(err.message).toContain('"out"');
    expect(err.message).not.toContain(g.root);
    expect(err.message).not.toContain(out);
  });
});
