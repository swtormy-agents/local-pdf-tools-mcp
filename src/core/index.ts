/**
 * The ONE place that selects the core implementation.
 * To use the real module, replace the import below, e.g.:
 *   import { core as impl } from "@noclaudkit/pdf-core";
 */
import { stubCore as impl } from "./stub.js";
import type { PdfCore } from "./types.js";

export const core: PdfCore = impl;
export * from "./types.js";
