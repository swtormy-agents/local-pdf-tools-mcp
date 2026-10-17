import { CoreError, type PdfCore } from "./types.js";

const notYet = async (): Promise<never> => {
  throw new CoreError("NOT_IMPLEMENTED", "This operation is not implemented yet (the PDF core module is not wired in).");
};

/** Placeholder until the shared core module is available. Every call throws NOT_IMPLEMENTED. */
export const stubCore: PdfCore = {
  info: notYet,
  merge: notYet,
  split: notYet,
  organize: notYet,
  imagesToPdf: notYet,
};
