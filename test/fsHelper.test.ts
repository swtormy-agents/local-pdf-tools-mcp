/**
 * Filesystem helper (src/anchor.ts) regressions for Megan's interim QA of 87b1d7b:
 * - F1: grandparent ABA (root/a <-> symlink to outside) during writes created empty files outside the root
 *   (qa87/mine.test.ts, QMODE=gp OP=write). Now: zero files outside, zero outside reads, for leaf and grandparent swaps.
 * - F2: Linux without /proc broke every read and write. Now /proc is not used at all; the "real no /proc" test reruns
 *   this file inside `unshare -rm` with a tmpfs mounted over /proc (skipped with a message where unshare is unavailable).
 * - F3: missing output folders are created by the helper relative to a verified directory.
 * - F4: per-request timeout, then the helper is killed and respawned.
 * QA87_N scales the race call count (default 1000; the stress run uses 20000), QA87_C the concurrency (default 32).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsCall, setFsTimeout } from "../src/anchor";
import { readInputs, writePdf } from "../src/io";
import { PathGuard } from "../src/pathGuard";
import { canSymlink, DIRLINK, tmpRoot } from "./helpers";

const N = Number(process.env.QA87_N ?? 1000);
const CONC = Number(process.env.QA87_C ?? 32);
const INNER = process.env.QA87_INNER_NOPROC === "1";
// QA F8: directory-link races always run (junctions on Windows need no privilege); file-symlink cases run when a
// runtime probe can create a symlink (skipped only on EPERM).
const SYMLINKS = true;
const FILE_SYMLINKS = await canSymlink();
const PDF = "%PDF-1.7\n%%EOF\n";

afterEach(() => setFsTimeout(30_000));

async function layout() {
  const base = await tmpRoot();
  const root = path.join(base, "root"), outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, "a", "rin"), { recursive: true });
  await fs.mkdir(path.join(outside, "rin"), { recursive: true });
  await fs.writeFile(path.join(root, "a", "rin", "doc.pdf"), PDF + "INSIDE");
  await fs.writeFile(path.join(outside, "rin", "doc.pdf"), PDF + "OUTSIDE SECRET");
  await fs.writeFile(path.join(outside, "doc.pdf"), PDF + "OUTSIDE SECRET");
  return { base, root, outside };
}

/** Everything below `d` except the planted doc.pdf files (files and folders). */
async function extra(d: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== "rin") out.push(p);
      out.push(...(await extra(p)));
    } else if (e.name !== "doc.pdf") out.push(p);
  }
  return out;
}

describe("filesystem helper", () => {
  it("reads and writes (also proves it works without /proc when run inside unshare)", async () => {
    if (INNER) expect(existsSync("/proc/self/fd")).toBe(false);
    const { root } = await layout();
    const guard = await PathGuard.create(root);
    for (let i = 0; i < 200; i++) {
      const [f] = await readInputs(guard, ["a/rin/doc.pdf"], "pdf");
      expect(Buffer.from(f.bytes).toString()).toBe(PDF + "INSIDE");
    }
    const dir = await guard.resolveOutputDir("new/x/y");
    expect(dir).toBe(path.join(root, "new", "x", "y"));
    for (let i = 0; i < 200; i++) await writePdf(guard, dir, "o", new TextEncoder().encode(PDF + i));
    expect((await fs.readdir(dir)).length).toBe(200);
    expect(await fs.readFile(path.join(dir, "o-7.pdf"), "utf8")).toBe(PDF + 7);
  });

  it.skipIf(!SYMLINKS)("missing output folders are never created through a swapped parent (F3)", async () => {
    const { root, outside } = await layout();
    const guard = await PathGuard.create(root);
    await fs.rename(path.join(root, "a"), path.join(root, "aa"));
    await fs.symlink(outside, path.join(root, "a"), DIRLINK);
    await expect(guard.resolveOutputDir("a/rin/new")).rejects.toMatchObject({ code: "SYMLINK_OUTSIDE_ROOT" });
    expect(await extra(outside)).toEqual([]);
  });

  it("a hung request times out with FS_TIMEOUT, the helper is respawned (F4)", async () => {
    setFsTimeout(300);
    await expect(fsCall({ op: "ping", ms: 5000 })).rejects.toMatchObject({ code: "FS_TIMEOUT" });
    setFsTimeout(30_000);
    expect((await fsCall({ op: "ping" })).h.ok).toBe(true);
    const { root } = await layout();
    const [f] = await readInputs(await PathGuard.create(root), ["a/rin/doc.pdf"], "pdf");
    expect(Buffer.from(f.bytes).toString()).toContain("INSIDE");
  });
});

// Megan's qa87/mine.test.ts as a regular test: 32 concurrent calls while a separate process swaps the leaf folder
// (sym) or the grandparent (gp) with a symlink to outside. Invariants: no outside content read, nothing at all
// (file or folder, empty or not) created outside, every failure coded.
describe.skipIf(!SYMLINKS)("QA87 race repro (junctions on Windows)", () => {
  for (const MODE of ["sym", "gp"] as const)
    for (const OP of ["read", "write"] as const)
      it(`megan87 ${MODE} ${OP}: nothing read from or created outside the root`, async () => {
        if (INNER) expect(existsSync("/proc/self/fd")).toBe(false);
        const { root, outside } = await layout();
        const guard = await PathGuard.create(root);
        const outDir = OP === "write" ? await guard.resolveOutputDir("a/rin") : "";
        const R = JSON.stringify(root), O = JSON.stringify(outside);
        const scripts = {
          sym: `for(;;){try{fs.renameSync(R+"/a/rin",R+"/a/rr");fs.symlinkSync(O,R+"/a/rin","${DIRLINK}");fs.unlinkSync(R+"/a/rin");fs.renameSync(R+"/a/rr",R+"/a/rin");}catch(e){}}`,
          gp: `for(;;){try{fs.renameSync(R+"/a",R+"/aa");fs.symlinkSync(O,R+"/a","${DIRLINK}");fs.unlinkSync(R+"/a");fs.renameSync(R+"/aa",R+"/a");}catch(e){}}`,
        };
        const sw = spawn(process.execPath, ["-e", `const fs=require("fs");const R=${R},O=${O};${scripts[MODE]}`], { stdio: "ignore" });
        await new Promise((r) => setTimeout(r, 150));
        const res = { ok: 0, outsideReads: 0, codes: {} as Record<string, number> };
        let i = 0;
        const worker = async () => {
          while (i < N) {
            i++;
            try {
              if (OP === "read") {
                const [f] = await readInputs(guard, ["a/rin/doc.pdf"], "pdf");
                res.ok++;
                if (Buffer.from(f.bytes).toString().includes("SECRET")) res.outsideReads++;
              } else {
                await writePdf(guard, outDir, "o", new TextEncoder().encode(PDF + "W"));
                res.ok++;
              }
            } catch (e: any) {
              const k = e.code ?? "NOCODE:" + e.message;
              res.codes[k] = (res.codes[k] ?? 0) + 1;
            }
          }
        };
        try {
          await Promise.all(Array.from({ length: CONC }, worker));
        } finally {
          const gone = new Promise((r) => sw.once("exit", r));
          sw.kill("SIGKILL");
          await gone;
        }
        const leaked = await extra(outside);
        const line = JSON.stringify({ MODE, OP, N, CONC, noProc: INNER, ...res, outsideCreated: leaked.length });
        console.log("megan87", line);
        expect(res.outsideReads, line).toBe(0);
        expect(leaked, line).toEqual([]);
        const allowed = ["INPUT_NOT_FOUND", "SYMLINK_OUTSIDE_ROOT", "PATH_CHANGED", "INPUT_NOT_FILE", "OUTPUT_DIR_CHANGED"];
        // Windows: creating a file in a folder that is being renamed/deleted by the swapper can fail with EPERM/EACCES
        // ("delete pending"), which the server reports as WRITE_FAILED. Nothing is created; the invariants above hold.
        if (process.platform === "win32") allowed.push("WRITE_FAILED");
        for (const k of Object.keys(res.codes)) expect(allowed, line).toContain(k);
      }, 1_200_000);
});

// F2: the same file inside a real mount namespace without /proc (not a test flag).
const unshareOk = process.platform === "linux" && !INNER && spawnSync("unshare", ["-rm", "true"]).status === 0;
if (process.platform === "linux" && !INNER && !unshareOk) console.warn("real no-/proc test skipped: `unshare -rm` is not available here");
describe.skipIf(!unshareOk)("real Linux without /proc (unshare -rm + tmpfs over /proc)", () => {
  it("helper reads, writes and races pass with /proc hidden", () => {
    const vitest = path.resolve("node_modules/vitest/vitest.mjs");
    const r = spawnSync(
      "unshare",
      ["-rm", "sh", "-c", `mount -t tmpfs none /proc && exec "${process.execPath}" "${vitest}" run test/fsHelper.test.ts`],
      { env: { ...process.env, QA87_INNER_NOPROC: "1" }, encoding: "utf8", timeout: 1_500_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    console.log(out.split("\n").filter((l) => /megan87|Tests |Test Files/.test(l)).join("\n"));
    expect(r.status, out.slice(-4000)).toBe(0);
    expect(out).toMatch(/Tests\s+\d+ passed/);
  }, 1_600_000);
});
