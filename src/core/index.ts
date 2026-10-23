/**
 * The ONE place that selects the core implementation: `@local-pdf-tools/core`
 * (git dependency `github:swtormy-agents/pdf-tools#<full sha>`, named ESM exports with types).
 * At build time esbuild inlines the core and pdf-lib into dist/ (see scripts/build.mjs), so the published
 * package has no git dependency.
 */
import { imagesToPdf, merge, organize, pdfInfo, split } from "@local-pdf-tools/core";
import type { PdfCore } from "./types.js";

export const core: PdfCore = Object.freeze({ pdfInfo, merge, split, organize, imagesToPdf });
export * from "./types.js";
