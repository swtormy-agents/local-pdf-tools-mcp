// Generates THIRD_PARTY_NOTICES from the installed packages (exact license files and source headers), so the texts
// are never retyped by hand. Run after changing the core sha or pdf-lib: `npm run notices`.
// `node scripts/notices.mjs --check` exits 1 if the committed file is out of date (used by test/release.test.ts).
// Which packages need an entry is decided by the bundle (build/metafile.json, see scripts/build.mjs); the test fails
// if the bundle inlines a package that has no section here.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => path.join(root, "node_modules", p);
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").trimEnd();
const version = (pkg) => JSON.parse(read(nm(`${pkg}/package.json`))).version;
const require = createRequire(import.meta.url);

/** Leading block comment (/* ... *\/) or run of // comments of a source file, without comment markers. */
function header(file, { lines } = {}) {
  const src = read(nm(file)).replace(/^'use strict';\n+/, "");
  let out;
  if (src.startsWith("/*")) {
    out = src.slice(2, src.indexOf("*/")).split("\n").map((l) => l.replace(/^\s?\*\s?/, "")).join("\n").trim();
  } else {
    const m = /^(?:\/\/.*\n)+/.exec(src);
    if (!m) throw new Error(`no header in ${file}`);
    out = m[0].split("\n").map((l) => l.replace(/^\/\/ ?/, "")).join("\n").trim();
  }
  if (lines) out = out.split("\n").slice(0, lines).join("\n").trim();
  return out;
}

/** Every leading block comment of a source file (pdf-lib's FlateStream.js has two: XPDF and pdf.js), verbatim. */
function blockHeaders(file) {
  const src = read(nm(file));
  const out = [];
  for (const m of src.matchAll(/\/\*\n([\s\S]*?)\*\//g)) {
    if (!/Copyright/.test(m[1])) continue;
    out.push(m[1].split("\n").map((l) => l.replace(/^\s?\*\s?/, "")).join("\n").trim());
  }
  if (out.length === 0) throw new Error(`no copyright header in ${file}`);
  return out.join("\n\n");
}

const coreThirdParty = () => read(nm("@local-pdf-tools/core/THIRD-PARTY.md"));
const squash = (t) => t.replace(/\s+/g, " ").trim();

/** A file from scripts/licenses/, vendored verbatim from upstream (the source URL is given in the section). */
const vendored = (name) => read(path.join(root, "scripts/licenses", name));

/**
 * pdfkit's LICENSE at the commit referenced by pdf-lib's svgPath header, verbatim (scripts/licenses/pdfkit-LICENSE).
 * Cross-checked against the copy in the core's THIRD-PARTY.md so both products ship the same text.
 */
function pdfkitLicense() {
  const text = vendored("pdfkit-LICENSE");
  const md = coreThirdParty();
  const sec = md.slice(md.indexOf("### pdfkit"));
  const blocks = [...sec.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  if (!blocks.some((b) => b.trimEnd() === text)) throw new Error("pdfkit LICENSE differs from the core's THIRD-PARTY.md");
  return text;
}

/** The Apache-2.0 text, checked (whitespace-insensitive) against the full text in the core's THIRD-PARTY.md. */
function apacheLicense() {
  const text = vendored("Apache-2.0.txt");
  const md = coreThirdParty();
  const sec = md.slice(md.indexOf("## Apache License 2.0"));
  const m = /```\n([\s\S]*?)\n```/.exec(sec);
  if (!m || squash(m[1]) !== squash(text)) throw new Error("Apache-2.0 text differs from the core's THIRD-PARTY.md");
  return text;
}

/**
 * base64-arraybuffer is not an installed package (pdf-lib and @pdf-lib/standard-fonts vendor its code), so its full
 * LICENSE-MIT text is taken from the core's THIRD-PARTY.md (copied there from base64-arraybuffer@0.1.5).
 */
function base64ArraybufferLicense() {
  const md = read(nm("@local-pdf-tools/core/THIRD-PARTY.md"));
  const sec = md.slice(md.indexOf("### base64-arraybuffer"));
  const m = /```\n([\s\S]*?)\n```/.exec(sec);
  if (!m || !m[1].startsWith("Copyright (c) 2012 Niklas von Hertzen")) throw new Error("base64-arraybuffer license not found in core THIRD-PARTY.md");
  return m[1];
}

/** Notice field of each AFM metrics file in @pdf-lib/standard-fonts (Adobe copyright + trademark lines). */
function adobeNotices() {
  const pako = require(nm("pako"));
  const dir = nm("@pdf-lib/standard-fonts/es");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".compressed.json") && !f.startsWith("all-"))
    .sort()
    .map((f) => {
      const json = JSON.parse(pako.inflate(Buffer.from(JSON.parse(read(path.join(dir, f))), "base64"), { to: "string" }));
      return `${f.replace(".compressed.json", "")}: ${json.Notice}`;
    })
    .join("\n");
}

const apache = apacheLicense();
const rule = "=".repeat(78);
const sub = "-".repeat(78);

/** One section per package inlined into dist/ by the build. `package` is matched against build/metafile.json. */
export const sections = [
  {
    package: "@local-pdf-tools/core",
    title: `@local-pdf-tools/core (pdf-tools) ${version("@local-pdf-tools/core")} - MIT\nhttps://github.com/swtormy-agents/pdf-tools`,
    parts: [read(nm("@local-pdf-tools/core/LICENSE"))],
  },
  {
    package: "pdf-lib",
    title: `pdf-lib ${version("pdf-lib")} - MIT\nhttps://github.com/Hopding/pdf-lib`,
    parts: [
      read(nm("pdf-lib/LICENSE.md")),
      `pdf-lib contains code from other projects (source headers quoted as shipped):\n\n` +
        `* Stream decoders (Stream, DecodeStream, FlateStream, LZWStream, Ascii85Stream, AsciiHexStream,\n  RunLengthStream): ports of Mozilla pdf.js and of XPDF, Apache License 2.0 (full text below).\n\n` +
        `Stream.js (the other decoders differ only in the class name):\n\n` + blockHeaders("pdf-lib/es/core/streams/Stream.js") + "\n\n" +
        `FlateStream.js:\n\n` + blockHeaders("pdf-lib/es/core/streams/FlateStream.js"),
      `* SVG path parser (es/api/svgPath.js), MIT:\n\n` + header("pdf-lib/es/api/svgPath.js") +
        "\n\npdfkit LICENSE, verbatim from\nhttps://github.com/foliojs/pdfkit/blob/1e62e6ffe24b378eb890df507a47610f4c4a7b24/LICENSE:\n\n" + pdfkitLicense(),
      `* Base64 helpers (es/utils/base64.js), MIT:\n\n` + header("pdf-lib/es/utils/base64.js") + "\n\nbase64-arraybuffer LICENSE-MIT:\n\n" + base64ArraybufferLicense(),
      `Apache License 2.0 (applies to the pdf.js and XPDF derived stream decoders above):\n\n${apache}`,
    ],
  },
  {
    package: "@pdf-lib/standard-fonts",
    title: `@pdf-lib/standard-fonts ${version("@pdf-lib/standard-fonts")} - MIT\nhttps://github.com/Hopding/standard-fonts`,
    parts: [
      read(nm("@pdf-lib/standard-fonts/LICENSE.md")),
      `Original repository's license (from its README):\n\n` +
        read(nm("@pdf-lib/standard-fonts/README.md")).split("## Original Repo's License")[1].trim() +
        "\n\nThe linked license text, verbatim from https://chbrown.github.io/licenses/MIT/#2015-2018:\n\n" + vendored("chbrown-MIT.txt"),
      `Base64 helpers (es/utils.js), MIT:\n\n` + header("@pdf-lib/standard-fonts/es/utils.js") + "\n\n(MIT license text: see base64-arraybuffer under pdf-lib above.)",
      `Font metrics of the 14 standard PDF fonts, derived from Adobe AFM files. Notice field of each file, verbatim:\n\n${adobeNotices()}`,
    ],
  },
  {
    package: "@pdf-lib/upng",
    title: `@pdf-lib/upng ${version("@pdf-lib/upng")} - MIT\nhttps://github.com/Hopding/upng`,
    parts: [read(nm("@pdf-lib/upng/LICENSE"))],
  },
  {
    package: "pako",
    title: `pako ${version("pako")} - (MIT AND Zlib)\nhttps://github.com/nodeca/pako`,
    parts: [
      read(nm("pako/LICENSE")),
      `zlib notice from the pako source headers (lib/zlib/*.js), verbatim:\n\n` + header("pako/lib/zlib/deflate.js"),
    ],
  },
  {
    package: "tslib",
    title: `tslib ${version("tslib")} - 0BSD\nhttps://github.com/Microsoft/tslib`,
    parts: [read(nm("tslib/LICENSE.txt"))],
  },
];

export function render() {
  const intro =
    "THIRD-PARTY SOFTWARE NOTICES\n\n" +
    "local-pdf-tools-mcp (MIT, see LICENSE) bundles the following third-party software into dist/.\n" +
    "@modelcontextprotocol/sdk and zod are not bundled; they are installed as regular npm dependencies with their\n" +
    "own license files. This file is generated by scripts/notices.mjs from the installed packages\n" +
    "(base64-arraybuffer's LICENSE-MIT comes from the THIRD-PARTY.md of @local-pdf-tools/core; the pdfkit,\n" +
    "Christopher Brown MIT and Apache-2.0 texts are vendored verbatim from upstream in scripts/licenses/ and\n" +
    "cross-checked against the core's THIRD-PARTY.md where it has them).";
  const body = sections.map((s) => `${rule}\n${s.title}\n${rule}\n\n${s.parts.join(`\n\n${sub}\n\n`)}`).join("\n\n\n");
  return `${intro}\n\n\n${body}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(root, "THIRD_PARTY_NOTICES");
  const text = render();
  if (process.argv.includes("--check")) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "";
    if (cur !== text) {
      console.error("THIRD_PARTY_NOTICES is out of date: run npm run notices");
      process.exit(1);
    }
  } else {
    fs.writeFileSync(file, text);
    console.error(`wrote ${file}`);
  }
}
