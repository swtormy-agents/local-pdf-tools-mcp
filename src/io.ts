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
  if (n > limits.maxFiles) throw new UserError(`Too many input files (${n}): max ${limits.maxFiles} per call.`, "TOO_MANY_FILES");
}

export function checkSizes(sizes: number[], limits: Limits = LIMITS, names: string[] = []): void {
  let total = 0;
  sizes.forEach((s, i) => {
    if (s > limits.maxFileBytes) {
      throw new UserError(`${names[i] ?? "Input"} is ${(s / MB).toFixed(1)} MB: max ${limits.maxFileBytes / MB} MB per file.`, "TOO_LARGE");
    }
    total += s;
  });
  if (total > limits.maxTotalBytes) {
    throw new UserError(`Inputs total ${(total / MB).toFixed(1)} MB: max ${limits.maxTotalBytes / MB} MB per call.`, "TOO_LARGE");
  }
}

/** Cheap signature check so obviously wrong files fail fast with a clear message (the core does the real header checks). */
export function sniff(bytes: Uint8Array, kind: InputKind, name: string): "pdf" | "jpeg" | "png" {
  const b = bytes;
  if (kind === "pdf") {
    // %PDF- may be preceded by junk; the spec allows it within the first 1024 bytes.
    const head = Buffer.from(b.subarray(0, 1024)).toString("latin1");
    if (head.includes("%PDF-")) return "pdf";
    throw new UserError(`${name} is not a PDF (no %PDF- header).`, "PDF_INVALID");
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && Buffer.from(b.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  throw new UserError(`${name} is not a JPEG or PNG image. Only JPEG and PNG are supported; convert it first.`, "UNSUPPORTED_IMAGE");
}

/**
 * Resolve, size-check and read inputs. This is the MCP-side pre-check with the core's LIMITS values
 * (the core enforces its limits again; `limits` is a parameter only so tests can use small values). Sizes are checked from fstat of the opened handle before reading,
 * and reads never exceed the per-file limit, so a file growing during the read cannot blow memory.
 */
export async function readInputs(guard: PathGuard, inputs: string[], kind: InputKind, limits: Limits = LIMITS): Promise<LoadedFile[]> {
  checkCounts(inputs.length, limits);
  const resolved = await Promise.all(inputs.map((p) => guard.resolveInputFile(p)));
  const out: LoadedFile[] = [];
  let total = 0;
  for (const [i, p] of resolved.entries()) {
    const fh = await fs.open(p, "r");
    try {
      const { size } = await fh.stat();
      checkSizes([size], limits, [inputs[i]]);
      total += size;
      checkSizes([total], { ...limits, maxFileBytes: Infinity });
      const buf = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const { bytesRead } = await fh.read(buf, off, size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, off);
      sniff(bytes, kind, inputs[i]);
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
