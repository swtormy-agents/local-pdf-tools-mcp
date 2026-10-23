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
    const c = fsCall({ op: "cleanup", root: guard.root, rootId: (guard as any).rootId, parts: ["o"], name: "x.pdf", id: `${st.dev}:${st.ino}`, testPauseMs: 600 });
    await new Promise((r) => setTimeout(r, 200));
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

  it("output folder moved out of the root during the check pause: cleanup refuses, outside untouched", async () => {
    const { root, outside, guard } = await setup();
    const f = path.join(root, "o", "x.pdf");
    await fs.writeFile(f, "ours");
    const st = await fs.stat(f, { bigint: true });
    const c = fsCall({ op: "cleanup", root: guard.root, rootId: (guard as any).rootId, parts: ["o"], name: "x.pdf", id: `${st.dev}:${st.ino}`, testPauseMs: 600 });
    await new Promise((r) => setTimeout(r, 200));
    await fs.rename(path.join(root, "o"), path.join(outside, "moved"));
    expect((await c).h.error).toBe("ECHANGED");
    expect(await fs.readFile(path.join(outside, "moved", "x.pdf"), "utf8")).toBe("ours");
  });
});
