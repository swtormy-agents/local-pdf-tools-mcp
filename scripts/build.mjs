// Release build: bundles src/ together with @local-pdf-tools/core and pdf-lib (and pdf-lib's own dependencies)
// into dist/, so the published package has no git dependency and no pdf-lib dependency.
// @modelcontextprotocol/sdk and zod stay external (regular npm dependencies), see README "Build and release".
// Writes build/metafile.json (not published) so tests can check which third-party packages were inlined
// (test/release.test.ts compares them with THIRD_PARTY_NOTICES).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies ?? {});

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { index: "src/index.ts", server: "src/server.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true, // index.js and server.js share one chunk instead of two copies of the core
  format: "esm",
  platform: "node",
  target: "node20",
  // pdf-lib, tslib and @pdf-lib/standard-fonts ship ESM under "module": prefer it (tree-shaking, no CJS wrapper).
  mainFields: ["module", "main"],
  external, // also matches subpaths such as @modelcontextprotocol/sdk/server/mcp.js
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
});
fs.mkdirSync(path.join(root, "build"), { recursive: true });
fs.writeFileSync(path.join(root, "build", "metafile.json"), JSON.stringify(result.metafile, null, 1));

const bundled = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) bundled.add(m[1]);
}
console.error(`dist built; bundled third-party packages: ${[...bundled].sort().join(", ")}`);
