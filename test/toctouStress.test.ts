/**
 * Megan's QA repros (qa/mcp-toctou stress.test.ts, out.test.ts, 2026-10-22) turned into assertions.
 * A separate process swaps a folder inside the root with a symlink to an outside folder in a tight loop.
 * Inputs: never the outside content (also with process.platform faked as darwin, i.e. no /proc/self/fd check).
 * Outputs: Linux creates no file outside (anchored via /proc/self/fd/<dirfd>); elsewhere at most an empty, never-written
 * file can appear outside (no openat in Node). Every reported success is inside the root.
 * TOCTOU_N scales the call count (CI stress job uses more).
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readInputs } from "../src/io";
import { PathGuard } from "../src/pathGuard";
import { tmpRoot } from "./helpers";

const N = Number(process.env.TOCTOU_N ?? 2000);
const realPlatform = process.platform;
afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform }));

function swapper(root: string, outside: string, name: string) {
  return spawn(process.execPath, ["-e", `const fs=require("fs");const D=${JSON.stringify(path.join(root, name))},O=${JSON.stringify(outside)};
    for(;;){try{fs.renameSync(D,D+"_real");fs.symlinkSync(O,D);fs.unlinkSync(D);fs.renameSync(D+"_real",D);}catch(e){}}`], { stdio: "ignore" });
}

async function dirs(sub: string) {
  const base = await tmpRoot();
  const root = path.join(base, "root"), outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, sub), { recursive: true });
  await fs.mkdir(outside);
  return { root, outside };
}

describe.skipIf(realPlatform === "win32")("TOCTOU stress (QA repro, symlinks need privileges on Windows)", () => {
  for (const sim of [false, true]) {
    it(`input: outside content never returned${sim ? " (macOS simulation: platform=darwin, no /proc)" : ""}`, async () => {
      const { root, outside } = await dirs("rin");
      await fs.writeFile(path.join(root, "rin", "doc.pdf"), "%PDF-1.7 INSIDE");
      await fs.writeFile(path.join(outside, "doc.pdf"), "%PDF-1.7 OUTSIDE SECRET");
      const guard = await PathGuard.create(root);
      if (sim) Object.defineProperty(process, "platform", { value: "darwin" });
      const sw = swapper(root, outside, "rin");
      const res = { ok: 0, outside: 0, codes: {} as Record<string, number> };
      try {
        for (let i = 0; i < N; i++) {
          try {
            const [f] = await readInputs(guard, ["rin/doc.pdf"], "pdf");
            res.ok++;
            if (Buffer.from(f.bytes).toString().includes("SECRET")) res.outside++;
          } catch (e: any) {
            res.codes[e.code ?? "NOCODE"] = (res.codes[e.code ?? "NOCODE"] ?? 0) + 1;
          }
        }
      } finally {
        sw.kill();
      }
      expect(res.outside, JSON.stringify(res)).toBe(0);
      expect(res.codes.NOCODE, JSON.stringify(res)).toBeUndefined();
    }, 600_000);
  }

  for (const sim of [false, true]) {
    it(`output: nothing created outside the root, every success inside${sim ? " (macOS simulation)" : ""}`, async () => {
      const { root, outside } = await dirs("rout");
      const guard = await PathGuard.create(root);
      const dir = await guard.resolveOutputDir("rout");
      if (sim) Object.defineProperty(process, "platform", { value: "darwin" });
      const sw = swapper(root, outside, "rout");
      const okNames: string[] = [];
      const res = { ok: 0, codes: {} as Record<string, number> };
      try {
        for (let i = 0; i < N; i++) {
          try {
            okNames.push(await guard.writeNewFile(dir, `o${i}`, "pdf", Buffer.from("%PDF-1.7 PAYLOAD")));
            res.ok++;
          } catch (e: any) {
            res.codes[e.code ?? "NOCODE"] = (res.codes[e.code ?? "NOCODE"] ?? 0) + 1;
          }
        }
      } finally {
        sw.kill();
      }
      await new Promise((r) => setTimeout(r, 100));
      // The swapper may be killed mid-cycle: the inside folder is either at its name or at <name>_real.
      const isDir = (p: string) => fs.lstat(p).then((s) => s.isDirectory(), () => false);
      const real = (await isDir(dir)) ? dir : dir + "_real";
      const leaked = await fs.readdir(outside);
      if (!sim) expect(leaked, JSON.stringify(res)).toEqual([]);
      else {
        // Without openat()/chdir (unavailable in Node / process-global) a parent swap at the exact open can still
        // create an EMPTY file outside off Linux: the fd is verified before any byte is written, so it is never written
        // to and never reported as success. Linux anchors the create via /proc/self/fd/<dirfd> (case above).
        for (const f of leaked) expect((await fs.stat(path.join(outside, f))).size, f).toBe(0);
        for (const t of okNames) expect(leaked).not.toContain(path.basename(t));
      }
      for (const t of okNames) expect((await fs.readFile(path.join(real, path.basename(t)), "utf8"))).toBe("%PDF-1.7 PAYLOAD");
      expect(res.codes.NOCODE, JSON.stringify(res)).toBeUndefined();
    }, 600_000);
  }
});
