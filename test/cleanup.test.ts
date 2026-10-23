/**
 * QA F7 (Megan, REPORT-1567044): FS_TIMEOUT / FS_HELPER_FAILED during a write used to leave a full or partial output
 * file in the root. The helper now reports {relative name, dev:ino} right after the O_EXCL create, before writing; on
 * timeout or crash a fresh helper walks to the parent (dev/ino checked, no symlink followed) and removes that name only
 * if it still has that dev:ino. Also checks the swap-between-check-and-unlink cases (nothing outside the root removed).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsCall, helperPid, setFsTimeout } from "../src/anchor";
import { writePdf } from "../src/io";
import { PathGuard, testHooks } from "../src/pathGuard";
import { DIRLINK, tmpRoot } from "./helpers";
const DATA = new Uint8Array(4 * 1024 * 1024).fill(65);
DATA.set(new TextEncoder().encode("%PDF-1.7\n"));

afterEach(() => {
  setFsTimeout(30_000);
  testHooks.writeExtra = undefined;
  testHooks.cleanupExtra = undefined;
});

async function setup() {
  const base = await tmpRoot();
  const root = path.join(base, "root"), outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, "o"), { recursive: true });
  await fs.mkdir(outside);
  return { root, outside, guard: await PathGuard.create(root) };
}

describe("F7: no output left after timeout or helper crash", () => {
  it("FS_TIMEOUT mid-write: the created file is removed, message says so", async () => {
    const { root, guard } = await setup();
    testHooks.writeExtra = { testSlowMs: 5000 };
    setFsTimeout(800);
    const e: any = await writePdf(guard, path.join(root, "o"), "ts", DATA).catch((x) => x);
    expect(e.code).toBe("FS_TIMEOUT");
    expect(e.message).toContain("partially written output file was removed");
    expect(await fs.readdir(path.join(root, "o"))).toEqual([]);
  });

  it("helper killed mid-write (FS_HELPER_FAILED): the partial file is removed", async () => {
    const { root, guard } = await setup();
    testHooks.writeExtra = { testSlowMs: 5000 };
    const p = writePdf(guard, path.join(root, "o"), "kw", DATA).catch((x) => x);
    for (let i = 0; i < 500; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const n = await fs.readdir(path.join(root, "o"));
      if (n.length && (await fs.stat(path.join(root, "o", n[0]))).size > 0) break;
    }
    expect((await fs.stat(path.join(root, "o", "kw.pdf"))).size).toBeGreaterThan(0);
    process.kill(helperPid()!, "SIGKILL");
    const e: any = await p;
    expect(e.code).toBe("FS_HELPER_FAILED");
    expect(e.message).toContain("partially written output file was removed");
    expect(await fs.readdir(path.join(root, "o"))).toEqual([]);
  });

  it("cleanup refuses a different file under the same name (dev:ino mismatch)", async () => {
    const { root, guard } = await setup();
    await fs.writeFile(path.join(root, "o", "x.pdf"), "other");
    const r = await fsCall({ op: "cleanup", root: guard.root, rootId: (guard as any).rootId, parts: ["o"], name: "x.pdf", id: "1:1" });
    expect(r.h.error).toBe("ECHANGED");
    expect(await fs.readFile(path.join(root, "o", "x.pdf"), "utf8")).toBe("other");
  });

  it("file swapped between the dev:ino check and the unlink: the replacement is kept", async () => {
    const { root, outside, guard } = await setup();
    const f = path.join(root, "o", "x.pdf");
    await fs.writeFile(f, "ours");
    const st = await fs.stat(f, { bigint: true });
    await fs.writeFile(path.join(outside, "secret.pdf"), "SECRET");
    let atPause!: () => void;
    const paused = new Promise<void>((r) => (atPause = r));
    const c = fsCall({ op: "cleanup", root: guard.root, rootId: (guard as any).rootId, parts: ["o"], name: "x.pdf", id: `${st.dev}:${st.ino}`, testPauseMs: 600 }, undefined, (h) => h.paused === "check" && atPause());
    await paused; // the helper has checked the id and is pausing before it moves the name
    await fs.rename(f, path.join(root, "ours.bak"));
    await fs.link(path.join(outside, "secret.pdf"), f).catch(() => fs.writeFile(f, "SECRET"));
    expect((await c).h.error).toBe("ECHANGED");
    expect(await fs.readFile(path.join(outside, "secret.pdf"), "utf8")).toBe("SECRET");
    expect(await fs.readFile(f, "utf8")).toBe("SECRET");
  });

  it("output folder swapped for a link to outside before cleanup: nothing outside removed", async () => {
    const { root, outside, guard } = await setup();
    const f = path.join(root, "o", "x.pdf");
    await fs.writeFile(f, "ours");
    const st = await fs.stat(f, { bigint: true });
    await fs.rename(path.join(root, "o"), path.join(root, "o.bak"));
    await fs.mkdir(path.join(outside, "d"));
    await fs.link(path.join(root, "o.bak", "x.pdf"), path.join(outside, "d", "x.pdf")); // same inode outside
    await fs.symlink(path.join(outside, "d"), path.join(root, "o"), DIRLINK);
    const r = await fsCall({ op: "cleanup", root: guard.root, rootId: (guard as any).rootId, parts: ["o"], name: "x.pdf", id: `${st.dev}:${st.ino}` });
    expect(r.h.error).toBe("ELOOP");
    expect(await fs.readFile(path.join(outside, "d", "x.pdf"), "utf8")).toBe("ours");
  });

  // Windows refuses to rename a folder that is a process's current directory (EBUSY), so this race cannot happen there.
  it.skipIf(process.platform === "win32")("output folder moved out of the root during the check pause: cleanup refuses, outside untouched", async () => {
    const { root, outside, guard } = await setup();
    const f = path.join(root, "o", "x.pdf");
    await fs.writeFile(f, "ours");
    const st = await fs.stat(f, { bigint: true });
    let atPause!: () => void;
    const paused = new Promise<void>((r) => (atPause = r));
    const c = fsCall({ op: "cleanup", root: guard.root, rootId: (guard as any).rootId, parts: ["o"], name: "x.pdf", id: `${st.dev}:${st.ino}`, testPauseMs: 600 }, undefined, (h) => h.paused === "check" && atPause());
    await paused; // the helper has checked the id and is pausing before it moves the name
    await fs.rename(path.join(root, "o"), path.join(outside, "moved"));
    expect((await c).h.error).toBe("ECHANGED");
    expect(await fs.readFile(path.join(outside, "moved", "x.pdf"), "utf8")).toBe("ours");
    expect(await fs.readdir(path.join(outside, "moved"))).toEqual(["x.pdf"]); // N5: nothing renamed there
  });

  const cleanupOf = (guard: PathGuard, name: string, id: string, extra: object = {}, onPause?: (p: string) => void) =>
    fsCall({ op: "cleanup", root: guard.root, rootId: (guard as any).rootId, parts: ["o"], name, id, ...extra }, undefined, (h) => h.paused && onPause?.(h.paused));
  const idOf = async (f: string) => {
    const st = await fs.stat(f, { bigint: true });
    return `${st.dev}:${st.ino}`;
  };

  it("N1 (Megan qa3e/b): foreign file swapped in, and the name re-created while moved aside: both foreign files survive", async () => {
    const { root, guard } = await setup();
    const f = path.join(root, "o", "x.pdf");
    await fs.writeFile(f, "ours");
    const id = await idOf(f);
    let atPause!: () => void;
    const paused = new Promise<void>((r) => (atPause = r));
    const c = cleanupOf(guard, "x.pdf", id, { testPauseMs: 400, testPauseAfterMoveMs: 600 }, (p) => p === "check" && atPause());
    await paused;
    await fs.rename(f, path.join(root, "ours.bak"));
    await fs.writeFile(f, "FOREIGN-1");
    let made = false;
    for (let i = 0; i < 300 && !made; i++) {
      await new Promise((r) => setTimeout(r, 5));
      made = await fs.writeFile(f, "FOREIGN-2", { flag: "wx" }).then(() => true, () => false);
    }
    expect(made).toBe(true);
    const r = await c;
    expect(r.h.error).toBe("ERESTORE");
    expect(r.h.tmp).toMatch(/^\.lpt-cleanup-[0-9a-f]{32}$/);
    const names = await fs.readdir(path.join(root, "o"));
    const content = await Promise.all(names.map((n) => fs.readFile(path.join(root, "o", n), "utf8")));
    expect(content.sort()).toEqual(["FOREIGN-1", "FOREIGN-2"]);
  });

  it("N2: random temp name; existing (old-style or foreign) .lpt-cleanup-* files are never touched", async () => {
    const { root, guard } = await setup();
    const f = path.join(root, "o", "x.pdf");
    await fs.writeFile(f, "ours");
    for (let i = 0; i < 50; i++) await fs.writeFile(path.join(root, "o", `.lpt-cleanup-${i}-${Date.now() + i}`), "FOREIGN");
    const before = (await fs.readdir(path.join(root, "o"))).filter((n) => n !== "x.pdf").sort();
    expect((await cleanupOf(guard, "x.pdf", await idOf(f))).h.error).toBeUndefined();
    const after = (await fs.readdir(path.join(root, "o"))).sort();
    expect(after).toEqual(before);
    for (const n of after) expect(await fs.readFile(path.join(root, "o", n), "utf8")).toBe("FOREIGN");
  });

  for (const code of ["EPERM", "ENOTSUP"])
    it(`no hard links (${code}, e.g. FAT/exFAT): cleanup does nothing, message says the file may remain`, async () => {
      const { root, guard } = await setup();
      const f = path.join(root, "o", "x.pdf");
      await fs.writeFile(f, "ours");
      const r = await cleanupOf(guard, "x.pdf", await idOf(f), { testLinkError: code });
      expect(r.h.error).toBe("ENOLINKSUPPORT");
      expect(await fs.readdir(path.join(root, "o"))).toEqual(["x.pdf"]);
      expect(await fs.readFile(f, "utf8")).toBe("ours");
      testHooks.writeExtra = { testSlowMs: 5000 };
      testHooks.cleanupExtra = { testLinkError: code };
      setFsTimeout(800);
      const e: any = await writePdf(guard, path.join(root, "o"), "t", DATA).catch((x) => x);
      expect(e.code).toBe("FS_TIMEOUT");
      expect(e.message).toContain('"o/t.pdf" may remain');
      expect(e.message).toContain("no hard links");
      expect((await fs.readdir(path.join(root, "o"))).sort()).toEqual(["t.pdf", "x.pdf"]);
    });

  it("N4: helper killed after create but before confirming it: the file is not deleted, message says it may remain", async () => {
    const { root, guard } = await setup();
    testHooks.writeExtra = { testPauseAfterCreateMs: 5000 };
    testHooks.onWriteProgress = (h) => {
      if (!h.created) setTimeout(() => process.kill(helperPid()!, "SIGKILL"), 300);
    };
    const e: any = await writePdf(guard, path.join(root, "o"), "k", DATA).catch((x) => x);
    testHooks.onWriteProgress = undefined;
    expect(e.code).toBe("FS_HELPER_FAILED");
    expect(e.message).toContain('An empty file "o/k.pdf" may remain');
    expect(e.message).not.toContain("No output file was created");
    expect(await fs.readdir(path.join(root, "o"))).toEqual(["k.pdf"]);
    expect((await fs.stat(path.join(root, "o", "k.pdf"))).size).toBe(0);
  });
});
