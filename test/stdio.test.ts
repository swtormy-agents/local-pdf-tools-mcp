/**
 * The bundled server (dist/index.js, built by `npm run build`, which `npm test` runs first) over real stdio:
 * stdout must carry nothing but JSON-RPC messages, even when pdf-lib inside the core prints parser warnings.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as fx from "@local-pdf-tools/core/fixtures";
import { describe, expect, it } from "vitest";
import { routeConsoleToStderr } from "../src/stdio";
import { tmpRoot } from "./helpers";

const DIST = path.resolve(__dirname, "../dist/index.js");

function runServer(root: string, requests: object[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST, "--root", root], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const want = requests.filter((r: any) => r.id !== undefined).length;
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      const answered = stdout.split("\n").filter((l) => l.includes('"id"')).length;
      if (answered >= want) child.stdin.end();
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    setTimeout(() => child.kill(), 15000).unref();
  });
}

describe("stdio transport (bundled dist)", () => {
  it("stdout is only valid JSON-RPC; core/pdf-lib warnings go to stderr", async () => {
    expect(fs.existsSync(DIST), "run npm run build first").toBe(true);
    const root = await tmpRoot();
    await fsp.writeFile(path.join(root, "truncated.pdf"), fx.truncatedPdf());
    await fsp.writeFile(path.join(root, "evil.pdf"), await fx.evilPdf());
    await fsp.writeFile(path.join(root, "enc.pdf"), fx.encryptedPdf());
    await fsp.writeFile(path.join(root, "gps.jpg"), fx.exifJpeg());
    await fsp.writeFile(path.join(root, "bad.png"), fx.pngWithSize(10, 10));
    const call = (id: number, name: string, args: object) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "pdf_info", { input: "truncated.pdf" }),
      call(4, "pdf_merge", { inputs: ["evil.pdf", "truncated.pdf"], outputDir: "out" }),
      call(5, "pdf_organize", { input: "evil.pdf", order: [2, 1], outputDir: "out" }),
      call(6, "pdf_info", { input: "enc.pdf" }),
      call(7, "images_to_pdf", { images: ["gps.jpg", "bad.png"], outputDir: "out" }),
    ];
    const { stdout, stderr } = await runServer(root, requests);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    const msgs = lines.map((l) => {
      let m: any;
      expect(() => (m = JSON.parse(l)), `stdout line is not JSON: ${l.slice(0, 200)}`).not.toThrow();
      return m;
    });
    for (const m of msgs) expect(m.jsonrpc).toBe("2.0");
    expect(msgs.map((m) => m.id).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
    expect(byId[2].result.tools).toHaveLength(5);
    expect(byId[3].result.content[0].text).toContain("[PDF_INVALID]");
    expect(byId[4].result.content[0].text).toContain("(truncated.pdf)");
    expect(byId[5].result.isError).toBeFalsy();
    expect(byId[6].result.content[0].text).toContain("[PDF_ENCRYPTED]");
    // pdf-lib's parser warnings for the truncated PDF really were printed, and on stderr.
    expect(stderr).toMatch(/Trying to parse invalid object|Invalid object ref/);
    expect(stderr).toContain("ready. Allowed root");
  });
});

describe("routeConsoleToStderr", () => {
  it("sends console.log/info/debug/dir/table/trace to console.error", () => {
    const seen: unknown[][] = [];
    const c = { error: (...a: unknown[]) => seen.push(a) } as unknown as Console;
    routeConsoleToStderr(c);
    c.log("a");
    c.info("b");
    c.debug("c");
    c.dir({ d: 1 });
    c.table([1]);
    c.trace("e");
    expect(seen).toEqual([["a"], ["b"], ["c"], [{ d: 1 }], [[1]], ["Trace:", "e"]]);
  });
});
