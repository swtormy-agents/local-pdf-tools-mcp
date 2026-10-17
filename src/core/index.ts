/**
 * The ONE place that selects the core implementation.
 *
 * The real core is `@local-pdf-tools/core` (git dependency `github:swtormy-agents/pdf-tools#<sha>`, ESM with types).
 * It is not pushed yet, so the stub below is wired in. To swap (see README, "Core module"):
 *   1. npm install "github:swtormy-agents/pdf-tools#<sha>"   (pin the full commit sha)
 *   2. replace the stub import below with the real one, e.g.
 *        import { core as impl } from "@local-pdf-tools/core";
 *      (adapt to the core's actual export shape if it exports plain functions)
 *   3. in src/limits.ts and src/errors.ts re-export LIMITS and ERROR_CODES from "@local-pdf-tools/core".
 */
import { stubCore as impl } from "./stub.js";
import type { PdfCore } from "./types.js";

export const core: PdfCore = impl;
export * from "./types.js";
