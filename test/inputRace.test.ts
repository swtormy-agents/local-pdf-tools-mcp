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
import { tmpRoot } from "./helpers";

// Creating symlinks on Windows needs admin rights or Developer Mode, which CI runners do not guarantee.
const SYMLINKS = process.platform !== "win32";

afterEach(() => {
  testHooks.beforeInputOpen = undefined;
  testHooks.afterInputOpen = undefined;
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
    await fs.symlink(outside, dir);
  };
  const swapBack = async () => {
    await fs.unlink(dir);
    await fs.rename(path.join(root, "rin_real"), dir);
  };
  return { base, root, outside, guard, swapToOutside, swapBack };
}

describe.skipIf(!SYMLINKS)("input TOCTOU: folder swapped for a symlink to outside (skipped on Windows: symlinks need privileges)", () => {
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
  it("last component swapped for a symlink: O_NOFOLLOW refuses it", async () => {
    const { root, outside, guard } = await setup();
    const file = path.join(root, "rin", "doc.pdf");
    testHooks.beforeInputOpen = async () => {
      await fs.rename(file, file + ".moved");
      await fs.symlink(path.join(outside, "doc.pdf"), file);
    };
    await expect(readInputs(guard, ["rin/doc.pdf"], "pdf")).rejects.toMatchObject({ code: "PATH_CHANGED" });
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
describe.skipIf(!SYMLINKS)("live race (poc/race.mjs, in mode)", () => {
  it("never reads the outside file; every failure has a code", async () => {
    const { root, outside } = await setup();
    await fs.writeFile(path.join(root, "rin", "doc.pdf"), await fx.plainPdf(3));
    await fs.writeFile(path.join(outside, "doc.pdf"), await fx.plainPdf(1));
    const swapper = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");const R=${JSON.stringify(root)},O=${JSON.stringify(outside)};
         for(;;){try{fs.renameSync(R+"/rin",R+"/rin_real");fs.symlinkSync(O,R+"/rin");fs.unlinkSync(R+"/rin");fs.renameSync(R+"/rin_real",R+"/rin");}catch(e){}}`,
      ],
      { stdio: "ignore" },
    );
    try {
      const server = await createServer({ allowedRoot: root });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "race", version: "0" });
      await client.connect(ct);
      const res = { ok: 0, outsideReads: 0, codes: {} as Record<string, number> };
      for (let i = 0; i < 400; i++) {
        const r: any = await client.callTool({ name: "pdf_info", arguments: { input: "rin/doc.pdf" } });
        if (r.isError) {
          const code = /\[([A-Z_]+)\]$/.exec(r.content[0].text)?.[1] ?? `NO_CODE: ${r.content[0].text.slice(0, 80)}`;
          res.codes[code] = (res.codes[code] ?? 0) + 1;
        } else {
          res.ok++;
          if (r.structuredContent.pageCount !== 3) res.outsideReads++;
        }
      }
      expect(res.outsideReads, JSON.stringify(res)).toBe(0);
      for (const code of Object.keys(res.codes)) expect(["INPUT_NOT_FOUND", "SYMLINK_OUTSIDE_ROOT", "PATH_CHANGED", "INPUT_NOT_FILE"], JSON.stringify(res)).toContain(code);
    } finally {
      swapper.kill();
    }
  }, 60_000);
});
