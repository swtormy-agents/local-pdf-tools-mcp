import { CoreError, type PdfCore } from "./types.js";

const notYet = async (): Promise<never> => {
  throw new CoreError("NOT_IMPLEMENTED", "This operation is not implemented yet (the PDF core module @local-pdf-tools/core is not wired in).");
};

/** Placeholder for @local-pdf-tools/core until it is published to git. Same signatures; every call throws NOT_IMPLEMENTED. */
export const stubCore: PdfCore = {
  info: notYet,
  merge: notYet,
  split: notYet,
  organize: notYet,
  imagesToPdf: notYet,
};
