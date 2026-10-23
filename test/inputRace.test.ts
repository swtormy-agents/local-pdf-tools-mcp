/**
 * QA M1/L1/L2 regressions (Megan, c699526): reading an input must not follow a path that was swapped after the
 * realpath check, must not read through a hard link, and races must answer with a code, never "Unexpected error.".
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fx from "@local-pdf-tools/core/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { readInputs } from "../src/io";
import { PathGuard, testHooks } from "../src/pathGuard";
import { createServer } from "../src/server";
import { canSymlink, DIRLINK, tmpRoot } from "./helpers";

// QA F8: directory-link races always run (junctions on Windows need no privilege); file-symlink cases run when a
// runtime probe can create a symlink (skipped only on EPERM).
const SYMLINKS = true;
const FILE_SYMLINKS = await canSymlink();

afterEach(() => {
  testHooks.beforeInputOpen = undefined;
  testHooks.afterInputOpen = undefined;
  testHooks.inputStep = undefined;
});

async function setup() {
  const base = await tmpRoot();
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, "rin"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "rin", "doc.pdf"), "%PDF-1.7 INSIDE");
  await fs.writeFile(path.join(outside, "doc.pdf"), "%PDF-1.7 OUTSIDE SECRET");
  const guard = await PathGuard.create(root);
  const dir = path.join(root, "rin");
  const swapToOutside = async () => {
    await fs.rename(dir, path.join(root, "rin_real"));
    await fs.symlink(outside, dir, DIRLINK);
  };
  const swapBack = async () => {
    await fs.unlink(dir);
    await fs.rename(path.join(root, "rin_real"), dir);
  };
  return { base, root, outside, guard, swapToOutside, swapBack };
}

describe.skipIf(!SYMLINKS)("input TOCTOU: folder swapped for a symlink to outside (junctions on Windows)", () => {
  it("swap between the check and open(): rejected, outside content never returned", async () => {
    const { guard, swapToOutside } = await setup();
    testHooks.beforeInputOpen = swapToOutside;
    await expect(readInputs(guard, ["rin/doc.pdf"], "pdf")).rejects.toMatchObject({ code: "PATH_CHANGED" });
  });
  it("swap before open() and back right after it (path looks fine again): dev/ino mismatch, rejected", async () => {
    const { guard, swapToOutside, swapBack } = await setup();
    testHooks.beforeInputOpen = swapToOutside;
    testHooks.afterInputOpen = swapBack;
    await expect(readInputs(guard, ["rin/doc.pdf"], "pdf")).rejects.toMatchObject({ code: "PATH_CHANGED" });
  });
  it.skipIf(!FILE_SYMLINKS)("last component swapped for a symlink: O_NOFOLLOW refuses it", async () => {
    const { root, outside, guard } = await setup();
    const file = path.join(root, "rin", "doc.pdf");
    testHooks.beforeInputOpen = async () => {
      await fs.rename(file, file + ".moved");
      await fs.symlink(path.join(outside, "doc.pdf"), file);
    };
    await expect(readInputs(guard, ["rin/doc.pdf"], "pdf")).rejects.toMatchObject({ code: "PATH_CHANGED" });
  });
  // The old macOS CI outsideReads:1 window: the folder is a symlink to outside when the helper starts and is
  // swapped back right after. The helper walks relative to verified directories, so it refuses the symlink.
  it("parent swapped for a symlink after the realpath check and back after the helper ran: rejected", async () => {
    const { guard, swapToOutside, swapBack } = await setup();
    const steps: string[] = [];
    testHooks.inputStep = async (s) => {
      steps.push(s);
      if (s === "beforeHelper") await swapToOutside();
    };
    testHooks.afterInputOpen = swapBack;
    const r = await readInputs(guard, ["rin/doc.pdf"], "pdf").then(
      (f) => Buffer.from(f[0].bytes).toString(),
      (e) => e,
    );
    expect(r).toMatchObject({ code: "PATH_CHANGED" });
    expect(steps).toEqual(["afterRealpath", "beforeHelper"]);
  });
  it.skipIf(process.platform === "win32")("a FIFO swapped in never blocks the read", async () => {
    const { root, guard } = await setup();
    const file = path.join(root, "rin", "doc.pdf");
    testHooks.beforeInputOpen = async () => {
      await fs.rm(file);
      await new Promise<void>((res, rej) => spawn("mkfifo", [file]).on("exit", (c) => (c === 0 ? res() : rej(new Error("mkfifo")))));
    };
    await expect(readInputs(guard, ["rin/doc.pdf"], "pdf")).rejects.toMatchObject({ code: expect.stringMatching(/^(INPUT_NOT_FILE|PATH_CHANGED)$/) });
  });
});

describe("input races and hard links (all platforms)", () => {
  it("file deleted between the check and open() -> INPUT_NOT_FOUND (not 'Unexpected error.')", async () => {
    const { root, guard } = await setup();
    testHooks.beforeInputOpen = () => fs.rm(path.join(root, "rin", "doc.pdf"));
    await expect(readInputs(guard, ["rin/doc.pdf"], "pdf")).rejects.toMatchObject({ code: "INPUT_NOT_FOUND" });
  });
  it("file replaced by another file between the check and open() -> rejected (dev/ino)", async () => {
    const { root, guard } = await setup();
    const file = path.join(root, "rin", "doc.pdf");
    testHooks.beforeInputOpen = async () => {
      // A new inode renamed over the checked name (rm + create could reuse the same inode number).
      await fs.writeFile(file + ".new", "%PDF-1.7 OTHER");
      await fs.rename(file + ".new", file);
    };
    await expect(readInputs(guard, ["rin/doc.pdf"], "pdf")).rejects.toMatchObject({ code: "PATH_CHANGED" });
  });
  it("a hard link inside the root to a file outside it is refused (nlink > 1) with a clear message", async () => {
    const { root, outside, guard } = await setup();
    await fs.link(path.join(outside, "doc.pdf"), path.join(root, "hard.pdf"));
    const err: any = await readInputs(guard, ["hard.pdf"], "pdf").catch((e) => e);
    expect(err?.code).toBe("PATH_CHANGED");
    expect(err.message).toMatch(/hard link/);
    expect(err.message).not.toContain("SECRET");
  });
  it("a normal file still reads (nlink 1, identity unchanged)", async () => {
    const { guard } = await setup();
    const [f] = await readInputs(guard, ["rin/doc.pdf"], "pdf");
    expect(Buffer.from(f.bytes).toString()).toBe("%PDF-1.7 INSIDE");
  });
});

// Adapted from Megan's poc/race.mjs: a separate process keeps swapping root/rin with a symlink to an outside folder
// while pdf_info runs in a loop. Not deterministic, so it asserts invariants only: never the outside document, and
// every error carries a code.
function startSwapper(root: string, outside: string, name: string) {
  return spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");const D=${JSON.stringify(path.join(root, name))},O=${JSON.stringify(outside)};
       for(;;){try{fs.renameSync(D,D+"_real");fs.symlinkSync(O,D,"${DIRLINK}");fs.unlinkSync(D);fs.renameSync(D+"_real",D);}catch(e){}}`,
    ],
    { stdio: "ignore" },
  );
}

async function connect(root: string) {
  const server = await createServer({ allowedRoot: root });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "race", version: "0" });
  await client.connect(ct);
  return client;
}

const codeOf = (r: any) => /\[([A-Z_]+)\]$/.exec(r.content[0].text)?.[1] ?? `NO_CODE: ${r.content[0].text.slice(0, 80)}`;

// Adapted from Megan's poc/race.mjs: a separate process keeps swapping root/rin with a symlink to an outside folder
// while pdf_info runs in a loop. Not deterministic, so it asserts invariants only: never the outside document, and
// every error carries a code. The "no /proc" variant turns off the Linux-only /proc/self/fd check so Linux exercises
// what macOS runs (the macOS CI failure, outsideReads 1, came from that path). RACE_ITER raises the loop count.
const ITER = Number(process.env.RACE_ITER ?? 400);
describe.skipIf(!SYMLINKS)("live race (poc/race.mjs, in mode)", () => {
  {
    it("never reads the outside file; every failure has a code", async () => {
      const { root, outside } = await setup();
      await fs.writeFile(path.join(root, "rin", "doc.pdf"), await fx.plainPdf(3));
      await fs.writeFile(path.join(outside, "doc.pdf"), await fx.plainPdf(1));
      const swapper = startSwapper(root, outside, "rin");
      try {
        const client = await connect(root);
        const res = { ok: 0, outsideReads: 0, codes: {} as Record<string, number> };
        for (let i = 0; i < ITER; i++) {
          const r: any = await client.callTool({ name: "pdf_info", arguments: { input: "rin/doc.pdf" } });
          if (r.isError) res.codes[codeOf(r)] = (res.codes[codeOf(r)] ?? 0) + 1;
          else {
            res.ok++;
            if (r.structuredContent.pageCount !== 3) res.outsideReads++;
          }
        }
        expect(res.outsideReads, JSON.stringify(res)).toBe(0);
        for (const code of Object.keys(res.codes)) expect(["INPUT_NOT_FOUND", "SYMLINK_OUTSIDE_ROOT", "PATH_CHANGED", "INPUT_NOT_FILE"], JSON.stringify(res)).toContain(code);
      } finally {
        swapper.kill();
      }
    }, 120_000);
  }

  // Output side of the same race: root/out is swapped with a symlink to an outside folder while pdf_merge writes.
  // Nothing may ever be created outside the root, and a reported success must name a file that is inside.
  it("never creates anything outside the root while outputDir is being swapped (out mode)", async () => {
    const { root, outside } = await setup();
    await fs.writeFile(path.join(root, "rin", "doc.pdf"), await fx.plainPdf(2));
    await fs.mkdir(path.join(root, "out"));
    const swapper = startSwapper(root, outside, "out");
    try {
      const client = await connect(root);
      const res = { ok: 0, codes: {} as Record<string, number> };
      for (let i = 0; i < Math.min(ITER, 200); i++) {
        const r: any = await client.callTool({ name: "pdf_merge", arguments: { inputs: ["rin/doc.pdf", "rin/doc.pdf"], outputDir: "out", outputName: `m${i}` } });
        if (r.isError) res.codes[codeOf(r)] = (res.codes[codeOf(r)] ?? 0) + 1;
        else res.ok++;
      }
      swapper.kill();
      const leaked = (await fs.readdir(outside)).filter((f) => f !== "doc.pdf");
      // The helper creates relative to a verified cwd: not even an empty file may appear outside (QA F1).
      expect(leaked, JSON.stringify(res)).toEqual([]);
      for (const f of leaked) expect((await fs.stat(path.join(outside, f))).size, f).toBe(0);
      for (const code of Object.keys(res.codes)) expect(["OUTPUT_DIR_CHANGED", "SYMLINK_OUTSIDE_ROOT", "PATH_CHANGED", "DIR_NOT_FOUND", "NOT_DIR"], JSON.stringify(res)).toContain(code);
    } finally {
      swapper.kill();
    }
  }, 120_000);

  // Megan's re-QA: many tool calls in flight at once (async interleaving at every await) while both the input and the
  // output folder are swapped. The server process has no process-global state (no chdir; only the serialized helper chdirs), so parallel calls must keep
  // every invariant: no outside read, no data written outside, every success inside, every failure coded, cwd intact.
  it("parallel tool calls under concurrent symlink swaps", async () => {
    const { root, outside } = await setup();
    await fs.writeFile(path.join(root, "rin", "doc.pdf"), await fx.plainPdf(3));
    await fs.writeFile(path.join(outside, "doc.pdf"), await fx.plainPdf(1));
    await fs.mkdir(path.join(root, "out"));
    const cwd = process.cwd();
    const sws = [startSwapper(root, outside, "rin"), startSwapper(root, outside, "out")];
    const res = { ok: 0, outsideReads: 0, codes: {} as Record<string, number> };
    const okFiles: string[] = [];
    try {
      const client = await connect(root);
      const BATCH = 32;
      for (let b = 0; b < Math.max(4, Math.floor(ITER / BATCH)); b++) {
        await Promise.all(
          Array.from({ length: BATCH }, async (_, j) => {
            const i = b * BATCH + j;
            const r: any =
              j % 2 === 0
                ? await client.callTool({ name: "pdf_info", arguments: { input: "rin/doc.pdf" } })
                : await client.callTool({ name: "pdf_merge", arguments: { inputs: ["rin/doc.pdf", "rin/doc.pdf"], outputDir: "out", outputName: `p${i}` } });
            if (r.isError) res.codes[codeOf(r)] = (res.codes[codeOf(r)] ?? 0) + 1;
            else {
              res.ok++;
              if (j % 2 === 0 && r.structuredContent.pageCount !== 3) res.outsideReads++;
              if (j % 2 === 1) okFiles.push(`p${i}.pdf`);
            }
          }),
        );
        expect(process.cwd()).toBe(cwd);
      }
    } finally {
      for (const s of sws) s.kill();
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(res.outsideReads, JSON.stringify(res)).toBe(0);
    const leaked = (await fs.readdir(outside)).filter((f) => f !== "doc.pdf");
    for (const f of leaked) expect((await fs.stat(path.join(outside, f))).size, f).toBe(0);
    for (const f of okFiles) expect(leaked).not.toContain(f);
    expect(leaked, JSON.stringify(res)).toEqual([]);
    const allowed = ["INPUT_NOT_FOUND", "SYMLINK_OUTSIDE_ROOT", "PATH_CHANGED", "INPUT_NOT_FILE", "OUTPUT_DIR_CHANGED", "DIR_NOT_FOUND", "NOT_DIR"];
    // Windows: EPERM/EACCES ("delete pending") on create in a folder being swapped -> WRITE_FAILED; nothing is
    // created (same as folderMoves/fsHelper). no outside reads/writes is asserted above. CI 40002617815.
    if (process.platform === "win32") allowed.push("WRITE_FAILED");
    for (const code of Object.keys(res.codes)) expect(allowed, JSON.stringify(res)).toContain(code);
  }, 300_000);
});
