import fs from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import { LIMITS, type Limits } from "./limits.js";
import type { PathGuard } from "./pathGuard.js";

const MB = 1024 * 1024;

export interface LoadedFile {
  path: string;
  bytes: Uint8Array;
}

export type InputKind = "pdf" | "image";

/** Count/size checks that need no file access (also used by tests). */
export function checkCounts(n: number, limits: Limits = LIMITS): void {
  if (n === 0) throw new UserError("No input files given.", "NO_INPUT");
  if (n > limits.MAX_FILES) throw new UserError(`Too many input files (${n}): max ${limits.MAX_FILES} per call.`, "TOO_MANY_FILES");
}

export function checkSizes(sizes: number[], limits: Limits = LIMITS, names: string[] = []): void {
  let total = 0;
  sizes.forEach((s, i) => {
    if (s > limits.MAX_FILE_BYTES) {
      throw new UserError(`${names[i] ?? "Input"} is ${(s / MB).toFixed(1)} MB: max ${limits.MAX_FILE_BYTES / MB} MB per file.`, "TOO_LARGE");
    }
    total += s;
  });
  if (total > limits.MAX_TOTAL_BYTES) {
    throw new UserError(`Inputs total ${(total / MB).toFixed(1)} MB: max ${limits.MAX_TOTAL_BYTES / MB} MB per call.`, "TOO_LARGE");
  }
}

/**
 * Cheap PDF signature check so obviously wrong files fail fast with the file name (the core parses and checks again).
 * There is no image check here: the core detects JPEG/PNG by signature (a PNG named .jpg is fine, HEIC/GIF/... are
 * UNSUPPORTED_IMAGE), so an MCP-side copy would only duplicate it.
 */
export function sniffPdf(bytes: Uint8Array, name: string): void {
  // %PDF- may be preceded by junk; the spec allows it within the first 1024 bytes.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!head.includes("%PDF-")) throw new UserError(`${name} is not a PDF (no %PDF- header).`, "PDF_INVALID");
}

/**
 * Resolve, size-check and read inputs. This is the MCP-side pre-check with the core's LIMITS values
 * (the core enforces its limits again; `limits` is a parameter only so tests can use small values). Sizes are checked from fstat of the opened handle before reading,
 * and reads never exceed the per-file limit, so a file growing during the read cannot blow memory.
 */
export async function readInputs(guard: PathGuard, inputs: string[], kind: InputKind, limits: Limits = LIMITS): Promise<LoadedFile[]> {
  checkCounts(inputs.length, limits);
  const out: LoadedFile[] = [];
  let total = 0;
  for (const [i, name] of inputs.entries()) {
    // Opened and identity-checked by the guard (no realpath-then-open race); read through the handle only.
    const { real: p, fh } = await guard.openInputFile(name);
    try {
      const { size } = await fh.stat();
      checkSizes([size], limits, [name]);
      total += size;
      checkSizes([total], { ...limits, MAX_FILE_BYTES: Infinity });
      const buf = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const { bytesRead } = await fh.read(buf, off, size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, off);
      if (kind === "pdf") sniffPdf(bytes, name);
      out.push({ path: p, bytes });
    } finally {
      await fh.close();
    }
  }
  return out;
}

/** Safe base name for outputs: letters, digits, '.', '_' and '-' only; no extension; no leading dot. */
export function outputBase(name: string | undefined, fallback: string): string {
  const base = (name ?? fallback).replace(/\.pdf$/i, "");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(base) || base.startsWith(".")) {
    throw new UserError('Output name may only contain letters, digits, ".", "_" and "-" (max 100 chars) and must not start with ".". Example: "merged".', "BAD_OUTPUT_NAME");
  }
  return base;
}

export function baseOf(p: string): string {
  return path.basename(p, path.extname(p)).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "document";
}

export async function writePdf(guard: PathGuard, dir: string, base: string, bytes: Uint8Array): Promise<string> {
  return guard.writeNewFile(dir, base, "pdf", Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}
