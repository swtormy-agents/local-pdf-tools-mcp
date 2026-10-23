/**
 * QA F9: Megan's qa156/mine.test.ts move modes as regular tests (were documented limits but untested).
 * A separate process moves folders across the root boundary (same filesystem, plain renames, no links) while 32
 * concurrent reads or writes run:
 *   out:  root/a/rin moved out of the root and back      gout: grandparent root/a moved out and back
 *   in:   outside/rin moved into the root in place of root/a/rin, and back
 * Asserted: every failure carries a known code; for out/gout no outside content is ever read and no output ends up
 * in a folder that was outside the root at creation time (only completed outputs that later moved out with it, which
 * the README lists as a limit). For "in", reading/writing the moved-in folder while it is inside the root is the
 * documented limit; the test records the counts and checks the invariant that the planted outside file at
 * outside/doc.pdf (never moved) is never read or written next to.
 * MOVES_N scales the calls (default 1000).
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readInputs, writePdf } from "../src/io";
import { PathGuard } from "../src/pathGuard";
import { tmpRoot } from "./helpers";

const N = Number(process.env.MOVES_N ?? 1000);
const C = 32;
const PDF = "%PDF-1.7\n%%EOF\n";
const ALLOWED = ["INPUT_NOT_FOUND", "SYMLINK_OUTSIDE_ROOT", "PATH_CHANGED", "INPUT_NOT_FILE", "OUTPUT_DIR_CHANGED", "PATH_OUTSIDE_ROOT"];
// Windows: EPERM/EACCES ("delete pending") on create in a folder being renamed -> WRITE_FAILED; nothing is created.
if (process.platform === "win32") ALLOWED.push("WRITE_FAILED");

const scripts = {
  out: `fs.mkdirSync(O+"/mv",{recursive:true});for(;;){try{fs.renameSync(R+"/a/rin",O+"/mv/rin");fs.renameSync(O+"/mv/rin",R+"/a/rin");}catch(e){}}`,
  in: `for(;;){try{fs.renameSync(R+"/a/rin",R+"/a/rr");fs.renameSync(O+"/rin",R+"/a/rin");fs.renameSync(R+"/a/rin",O+"/rin");fs.renameSync(R+"/a/rr",R+"/a/rin");}catch(e){}}`,
  gout: `for(;;){try{fs.renameSync(R+"/a",O+"/ga");fs.renameSync(O+"/ga",R+"/a");}catch(e){}}`,
};

async function files(d: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out;
}

describe("F9: folders moved into / out of the root during operations", () => {
  for (const MODE of ["out", "gout", "in"] as const)
    for (const OP of ["read", "write"] as const)
      it(`moves ${MODE} ${OP}`, async () => {
        const base = await tmpRoot();
        const root = path.join(base, "root"), outside = path.join(base, "outside");
        await fs.mkdir(path.join(root, "a", "rin"), { recursive: true });
        await fs.mkdir(path.join(outside, "rin"), { recursive: true });
        await fs.writeFile(path.join(root, "a", "rin", "doc.pdf"), PDF + "INSIDE");
        await fs.writeFile(path.join(outside, "rin", "doc.pdf"), PDF + "MOVEDIN");
        await fs.writeFile(path.join(outside, "doc.pdf"), PDF + "OUTSIDE SECRET");
        const guard = await PathGuard.create(root);
        const outDir = OP === "write" ? await guard.resolveOutputDir("a/rin") : "";
        const R = JSON.stringify(root), O = JSON.stringify(outside);
        const sw = spawn(process.execPath, ["-e", `const fs=require("fs");const R=${R},O=${O};${scripts[MODE]}`], { stdio: "ignore" });
        await new Promise((r) => setTimeout(r, 100));
        const res = { ok: 0, secret: 0, movedIn: 0, codes: {} as Record<string, number> };
        let i = 0;
        const worker = async () => {
          while (i < N) {
            i++;
            try {
              if (OP === "read") {
                const [f] = await readInputs(guard, ["a/rin/doc.pdf"], "pdf");
                const t = Buffer.from(f.bytes).toString();
                if (t.includes("SECRET")) res.secret++;
                if (t.includes("MOVEDIN")) res.movedIn++;
              } else await writePdf(guard, outDir, "o", new TextEncoder().encode(PDF + "W"));
              res.ok++;
            } catch (e: any) {
              const k = e.code ?? "NOCODE";
              res.codes[k] = (res.codes[k] ?? 0) + 1;
            }
          }
        };
        try {
          await Promise.all(Array.from({ length: C }, worker));
        } finally {
          const gone = new Promise((r) => sw.once("exit", r));
          sw.kill("SIGKILL");
          await gone;
        }
        const line = JSON.stringify({ MODE, OP, N, ...res });
        console.log("moves", line);
        for (const k of Object.keys(res.codes)) expect(ALLOWED, line).toContain(k);
        expect(res.secret, line).toBe(0);
        // Nothing is ever created directly in outside/ (the never-moved folder).
        expect((await fs.readdir(outside)).filter((n) => n.startsWith("o")), line).toEqual([]);
        if (MODE !== "in") expect(res.movedIn, line).toBe(0);
        // Every file anywhere is a planted doc.pdf or a complete output.
        for (const f of [...(await files(root)), ...(await files(outside))])
          if (path.basename(f).startsWith("o")) expect(await fs.readFile(f, "utf8"), f).toBe(PDF + "W");
      }, 600_000);
});
