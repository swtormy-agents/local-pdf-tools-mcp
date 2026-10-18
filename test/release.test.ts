/**
 * Release prep (nothing is published): the bundle inlines the core + pdf-lib, every inlined package has a notice,
 * and the packed tarball carries dist/ and THIRD_PARTY_NOTICES with no git dependency. Needs `npm run build`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const pkg = JSON.parse(read("package.json"));

function bundledPackages(): string[] {
  const meta = JSON.parse(read("build/metafile.json"));
  const set = new Set<string>();
  for (const input of Object.keys(meta.inputs)) {
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, "/"));
    if (m) set.add(m[1]);
  }
  return [...set].sort();
}

describe("bundle", () => {
  it("inlines the core and pdf-lib; imports only node:, the MCP SDK and zod at runtime", () => {
    expect(bundledPackages()).toEqual(expect.arrayContaining(["@local-pdf-tools/core", "pdf-lib"]));
    expect(bundledPackages()).not.toContain("zod");
    expect(bundledPackages().some((p) => p.startsWith("@modelcontextprotocol/"))).toBe(false);
    for (const f of fs.readdirSync(path.join(ROOT, "dist")).filter((f) => f.endsWith(".js"))) {
      const src = read(`dist/${f}`);
      const specs = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*"([^"]+)"|^\s*import\s*"([^"]+)"/gm)].map((m) => m[1] ?? m[2]);
      for (const s of specs) expect(s, `${f} imports ${s}`).toMatch(/^(node:|\.\/|@modelcontextprotocol\/sdk\/|zod$)/);
      expect(src, f).not.toMatch(/require\("(pdf-lib|@local-pdf-tools)/);
    }
  });
  it("THIRD_PARTY_NOTICES is generated, up to date, and covers every inlined package", async () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/notices.mjs"), "--check"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const { sections } = await import("../scripts/notices.mjs");
    const covered = (sections as { package: string }[]).map((s) => s.package).sort();
    expect(covered).toEqual(bundledPackages());
    const notices = read("THIRD_PARTY_NOTICES").replace(/\r\n/g, "\n"); // tolerate a CRLF checkout
    for (const needle of [
      "Copyright (c) 2026 swtormy-agents", // pdf-tools
      "Copyright (c) 2019 Andrew Dillon", // pdf-lib
      "Copyright (c) 2018 Andrew Dillon", // standard-fonts
      "Copyright (c) 2017 Photopea", // upng
      "Vitaly Puzrin and Andrei Tuputcyn", // pako LICENSE
      "(C) 1995-2013 Jean-loup Gailly and Mark Adler", // zlib notice from pako headers
      "Copyright (c) Microsoft Corporation.", // tslib
      "Copyright (c) 2012 Niklas von Hertzen", // base64-arraybuffer
      "Copyright 2012 Mozilla Foundation", // pdf.js-derived streams
      "Copyright 1996-2003 Glyph & Cog, LLC", // XPDF-derived flate
      "Apache License\n                           Version 2.0, January 2004",
      "Copyright (c) 2014 Devon Govett", // pdfkit svg path
      "Christopher Brown", // standard-fonts upstream
      "Helvetica is a trademark of Linotype-Hell AG",
      "Times is a trademark of Linotype-Hell AG",
      "ITC Zapf Dingbats is a registered trademark of International Typeface Corporation.",
    ]) {
      expect(notices, needle).toContain(needle);
    }
  });
});

describe("notices vs. the core's THIRD-PARTY.md", () => {
  const notices = () => read("THIRD_PARTY_NOTICES").replace(/\r\n/g, "\n");
  it("contains each of the 14 verbatim blocks of the core's THIRD-PARTY.md, byte for byte (CRLF->LF only)", () => {
    const md = read("node_modules/@local-pdf-tools/core/THIRD-PARTY.md").replace(/\r\n/g, "\n");
    const blocks = [...md.matchAll(/^```\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
    expect(blocks).toHaveLength(14);
    const all = notices();
    for (const b of blocks) {
      // Source-header blocks (/* ... */ or // lines) are quoted in NOTICES without the comment markers; the text
      // itself must still match exactly, line by line. Everything else must appear unchanged.
      const isComment = /^(\/\*|\/\/)/.test(b);
      const text = isComment
        ? b
            .split("\n")
            .filter((l) => !/^\s*(\/\*|\*\/)\s*$/.test(l))
            .map((l) => l.replace(/^ \*( |$)/, "").replace(/^\/\/ ?/, ""))
            .join("\n")
        : b;
      expect(all.includes(text), `missing verbatim: ${text.slice(0, 80)}`).toBe(true);
    }
  });
  it("pdfkit and Christopher Brown sections use their own verbatim license texts (no generic MIT under another line)", () => {
    const n = notices();
    expect(n).toContain(read("scripts/licenses/pdfkit-LICENSE").replace(/\r\n/g, "\n").trimEnd());
    expect(n).toContain("MIT LICENSE\nCopyright (c) 2014 Devon Govett\n\nPermission is hereby granted");
    expect(n).toContain(read("scripts/licenses/chbrown-MIT.txt").replace(/\r\n/g, "\n").trimEnd());
    expect(n).not.toContain("MIT License\n\nCopyright (c) 2014 Devon Govett");
  });
});

describe("package", () => {
  it("has no github: (or other git) runtime dependency; the core is a devDependency", () => {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"]) {
      for (const [name, spec] of Object.entries<string>(pkg[field] ?? {})) {
        expect(`${name}@${spec}`).not.toMatch(/github:|git\+|git:|\.git#|^[^@]+@[\w-]+\/[\w.-]+#/);
      }
    }
    expect(pkg.dependencies["@local-pdf-tools/core"]).toBeUndefined();
    expect(pkg.dependencies["pdf-lib"]).toBeUndefined();
    expect(pkg.devDependencies["@local-pdf-tools/core"]).toMatch(/^github:swtormy-agents\/pdf-tools#[0-9a-f]{40}$/);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "zod"]);
  });
  it("npm pack --dry-run ships dist/ and THIRD_PARTY_NOTICES only (plus README/LICENSE/package.json)", () => {
    const out = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const [info] = JSON.parse(out);
    const files: string[] = info.files.map((f: { path: string }) => f.path.replace(/\\/g, "/")).sort();
    expect(files).toEqual(expect.arrayContaining(["LICENSE", "README.md", "THIRD_PARTY_NOTICES", "dist/index.js", "dist/server.js", "package.json"]));
    for (const f of files) expect(f).toMatch(/^(LICENSE|README\.md|THIRD_PARTY_NOTICES|package\.json|dist\/[\w.-]+\.js)$/);
  });
});
