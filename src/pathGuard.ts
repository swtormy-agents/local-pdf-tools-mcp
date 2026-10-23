import fs from "node:fs/promises";
import path from "node:path";
import { assertSafeRoot } from "./config.js";
import { UserError } from "./errors.js";

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;

/** True for names Windows treats as devices, with or without an extension ("NUL", "con.txt", "COM1.tar.gz"). */
export function isWindowsReserved(name: string): boolean {
  const stem = name.split(".")[0].replace(/[ .]+$/, "");
  return WIN_RESERVED.test(stem);
}

/**
 * Reject path forms that are dangerous or ambiguous on Windows, on every platform, so behaviour is the same everywhere:
 * - drive-relative paths such as "C:foo" (relative to the current dir of drive C)
 * - NTFS alternate data streams ("file.png:stream") - any ':' other than an absolute drive prefix "C:\"
 * - reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, CONIN$, CONOUT$) in any path segment
 */
export function assertPortablePath(p: string): void {
  let rest = p;
  if (/^[A-Za-z]:/.test(p)) {
    if (!/^[A-Za-z]:[\\/]/.test(p)) {
      throw new UserError(`Drive-relative path "${p}" is not allowed. Use a path relative to the allowed root or a full absolute path.`, "PATH_INVALID");
    }
    rest = p.slice(2);
  }
  if (rest.includes(":")) {
    throw new UserError(`Path "${p}" contains ':' (alternate data streams and drive prefixes are not allowed inside paths).`, "PATH_INVALID");
  }
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg && seg !== "." && seg !== ".." && isWindowsReserved(seg)) {
      throw new UserError(`Path "${p}" uses the reserved Windows device name "${seg}". Rename the file or folder.`, "PATH_RESERVED_NAME");
    }
  }
}

import { fsCall, identKey, type FsHeader } from "./anchor.js";

/** Test-only hooks to simulate races (e.g. swapping a directory for a symlink). Never set in production. */
export const testHooks: {
  /** Called after output dir resolution, before the data is produced and sent to the helper (slow decode). */
  beforeWrite?: (dir: string) => Promise<void> | void;
  /** Called immediately before the helper creates the output file (tightest race on the server side). */
  beforeOpen?: (dir: string) => Promise<void> | void;
  /** Called after the helper request finished (success or failure), e.g. to swap a directory back. */
  afterOpen?: (dir: string) => Promise<void> | void;
  /** Input side: called after the realpath/stat check, immediately before the helper opens the input. */
  beforeInputOpen?: (real: string) => Promise<void> | void;
  /** Input side: called after the helper request finished. */
  afterInputOpen?: (real: string) => Promise<void> | void;
  /** Input side: called at named steps ("afterRealpath", "beforeHelper"). */
  inputStep?: (step: string) => Promise<void> | void;
} = {};

/** Error codes of the helper that mean "a file or folder on the way was replaced/moved concurrently". */
const RACE_CODES = new Set(["ELOOP", "ECHANGED", "ENOENT", "ENOTDIR"]);
/** Genuine "cannot write here" errors. */
const WRITE_CODES = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "EMFILE", "ENFILE", "EFBIG", "EIO"]);

/**
 * Restricts all file access to one allowed root directory.
 * - Relative paths are resolved against the root; ".." traversal and absolute paths outside the root are rejected
 *   lexically before any I/O.
 * - Symlinks are resolved with realpath first; a link that points outside the root is rejected.
 * - Every open/create/mkdir under the root then runs in the filesystem helper (anchor.ts), relative to a directory
 *   verified component by component (no symlinks/junctions, dev/ino linked from the root): nothing outside the root
 *   is read or created, even if a folder is swapped at any moment.
 * Error messages name paths relative to the root only (never the absolute root or a location outside it).
 */
export class PathGuard {
  private constructor(
    public readonly root: string,
    private readonly rootId: string,
  ) {}

  static async create(root: string): Promise<PathGuard> {
    let real: string;
    try {
      real = await fs.realpath(root);
    } catch {
      throw new UserError(`Allowed root directory does not exist: ${root}. Set --root or LOCAL_PDF_TOOLS_ROOT to an existing directory.`, "ROOT_MISSING");
    }
    const st = await fs.stat(real, { bigint: true });
    if (!st.isDirectory()) throw new UserError(`Allowed root is not a directory: ${root}.`, "ROOT_NOT_DIR");
    assertSafeRoot(real);
    return new PathGuard(real, identKey(st));
  }

  isInside(p: string): boolean {
    const rel = path.relative(this.root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /** Root-relative display form ("." for the root, "/" separators) for messages. */
  private show(abs: string): string {
    const r = path.relative(this.root, abs);
    return r === "" ? "." : r.split(path.sep).join("/");
  }

  private partsOf(dir: string): string[] {
    const r = path.relative(this.root, dir);
    return r === "" ? [] : r.split(path.sep);
  }

  private lexical(p: string): string {
    if (typeof p !== "string" || p.length === 0) throw new UserError("Path must be a non-empty string.", "PATH_EMPTY");
    if (p.includes("\0")) throw new UserError("Path contains a NUL byte.", "PATH_INVALID");
    assertPortablePath(p);
    const abs = path.resolve(this.root, p);
    if (!this.isInside(abs)) {
      throw new UserError(`Path "${p}" is outside the allowed root. Use a path relative to the allowed root, or restart the server with a different --root.`, "PATH_OUTSIDE_ROOT");
    }
    return abs;
  }

  private async real(abs: string, original: string): Promise<string> {
    const real = await fs.realpath(abs);
    if (!this.isInside(real)) {
      throw new UserError(`Path "${original}" resolves (via a symlink) to a location outside the allowed root. Symlinks may only point inside the allowed root.`, "SYMLINK_OUTSIDE_ROOT");
    }
    return real;
  }

  private notFound(p: string): UserError {
    return new UserError(`Input file not found: "${p}".`, "INPUT_NOT_FOUND");
  }

  private changed(p: string): UserError {
    return new UserError(
      `Input "${p}" changed while it was being opened (the file, a symlink or a folder in its path was replaced). It was not read. Make sure nothing else modifies the folder and try again.`,
      "PATH_CHANGED",
    );
  }

  private helperFailed(e: unknown, what: string): UserError {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "FS_TIMEOUT") return new UserError(`${what} timed out (the filesystem did not answer within the time limit). Nothing was read or written.`, "FS_TIMEOUT");
    return new UserError(`${what} failed: the filesystem helper process stopped unexpectedly. Try again.`, "FS_HELPER_FAILED");
  }

  /** Resolve an existing regular file for reading (path checks only; read through readInputFile). */
  async resolveInputFile(p: string): Promise<string> {
    return (await this.checkInputFile(p)).real;
  }

  /** realpath inside the root + stat (bigint identity) of an input that must be a regular file. */
  private async checkInputFile(p: string): Promise<{ real: string; st: import("node:fs").BigIntStats }> {
    const abs = this.lexical(p);
    let real: string;
    let st: import("node:fs").BigIntStats;
    try {
      real = await this.real(abs, p);
      await testHooks.inputStep?.("afterRealpath");
      st = await fs.stat(real, { bigint: true });
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw this.notFound(p);
    }
    if (!st.isFile()) throw new UserError(`Input "${p}" is not a regular file.`, "INPUT_NOT_FILE");
    return { real, st };
  }

  /**
   * Read an input file without a check-then-use race. realpath (inside the root) and stat give the expected identity;
   * the helper then opens the last component relative to the verified directory with O_RDONLY|O_NOFOLLOW|O_NONBLOCK,
   * requires a regular file with nlink 1 and the expected dev/ino, enforces `maxBytes` (from fstat, before reading;
   * -1 = no limit) and re-verifies the entry and the directory chain after reading. Returns `{ tooLarge, size }`
   * instead of bytes when the file exceeds `maxBytes`.
   */
  async readInputFile(p: string, maxBytes: number): Promise<{ real: string; bytes?: Uint8Array; tooLarge?: boolean; size?: number }> {
    const { real, st } = await this.checkInputFile(p);
    let r;
    try {
      await testHooks.beforeInputOpen?.(real);
      await testHooks.inputStep?.("beforeHelper");
      r = await fsCall({
        op: "read",
        root: this.root,
        rootId: this.rootId,
        parts: this.partsOf(path.dirname(real)),
        name: path.basename(real),
        expect: identKey(st),
        max: Number.isFinite(maxBytes) ? maxBytes : -1,
      }).catch((e) => {
        throw this.helperFailed(e, `Reading "${p}"`);
      });
    } finally {
      await testHooks.afterInputOpen?.(real);
    }
    const h: FsHeader = r.h;
    if (!h.error) return { real, bytes: new Uint8Array(r.p.buffer, r.p.byteOffset, r.p.byteLength) };
    switch (h.error) {
      case "ETOOLARGE":
        return { real, tooLarge: true, size: h.size };
      case "ENOENT":
      case "ENOTDIR":
        throw this.notFound(p);
      case "ENOTFILE":
      case "EISDIR":
      case "ENXIO":
        throw new UserError(`Input "${p}" is not a regular file.`, "INPUT_NOT_FILE");
      case "EHARDLINK":
        throw new UserError(
          `Input "${p}" is a hard link (${h.nlink} names for the same file). Hard links can point at files outside the allowed root, so they are refused. Copy the file into the allowed root instead.`,
          "PATH_CHANGED",
        );
      default:
        // ELOOP (symlink/junction on the way or at the name), ECHANGED (identity or chain changed), or any other errno
        // while a file that was just checked is opened: a concurrent change. Nothing was returned.
        throw this.changed(p);
    }
  }

  /** Resolve an existing directory for reading. */
  async resolveInputDir(p: string): Promise<string> {
    const abs = this.lexical(p);
    let real: string;
    try {
      real = await this.real(abs, p);
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(`Directory not found: "${p}".`, "DIR_NOT_FOUND");
    }
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new UserError(`"${p}" is not a directory.`, "NOT_DIR");
    return real;
  }

  private dirChanged(p: string): UserError {
    return new UserError(`Output directory "${p}" changed or disappeared while it was being prepared. Nothing was written.`, "OUTPUT_DIR_CHANGED");
  }

  /**
   * Resolve (and create if needed) an output directory inside the root. The deepest existing ancestor is resolved
   * with realpath (must be inside the root); missing folders are created by the helper, one relative mkdir at a time
   * inside a verified directory, so a swapped parent cannot make it create a folder outside the root.
   */
  async resolveOutputDir(p: string): Promise<string> {
    const abs = this.lexical(p);
    let cur = abs;
    const missing: string[] = [];
    for (;;) {
      try {
        await fs.lstat(cur);
        break;
      } catch {
        missing.unshift(path.basename(cur));
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
    let realBase: string;
    let st: import("node:fs").Stats;
    try {
      realBase = await this.real(cur, p);
      st = await fs.stat(realBase);
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw this.dirChanged(p);
    }
    if (!st.isDirectory()) throw new UserError(`Output path "${p}" is not a directory.`, "OUTPUT_NOT_DIR");
    const out = path.join(realBase, ...missing);
    if (missing.length === 0) return out;
    const r = await fsCall({ op: "mkdirs", root: this.root, rootId: this.rootId, parts: this.partsOf(out) }).catch((e) => {
      throw this.helperFailed(e, `Creating output directory "${p}"`);
    });
    if (r.h.error) {
      if (WRITE_CODES.has(r.h.error) && !RACE_CODES.has(r.h.error)) {
        throw new UserError(`Could not create output directory "${p}" (${r.h.error}).`, "WRITE_FAILED");
      }
      throw this.dirChanged(p);
    }
    return out;
  }

  /**
   * Write `data` to a new file `<base>[-N].<ext>` in `dir` (a directory returned by resolveOutputDir) without
   * overwriting anything and without creating anything outside the root. The helper enters `dir` component by
   * component (verified), creates the file relative to it with O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, re-verifies the
   * entry and the chain before and after writing, writes, fsyncs and closes. On any failure it removes its own new
   * file by relative name in the same verified directory (only if that name is still its inode), so no partial or
   * empty output is left behind. `data` may be a producer; if it throws, nothing is created.
   */
  async writeNewFile(dir: string, base: string, ext: string, data: Uint8Array | (() => Promise<Uint8Array> | Uint8Array)): Promise<string> {
    if (isWindowsReserved(base)) base = `_${base}`;
    const shown = this.isInside(dir) ? this.show(dir) : "(output directory)";
    await testHooks.beforeWrite?.(dir);
    let bytes: Uint8Array;
    try {
      bytes = typeof data === "function" ? await data() : data;
    } catch (e) {
      throw new UserError(`Producing the output failed (${e instanceof Error ? e.message : String(e)}). Nothing was written.`, "WRITE_FAILED");
    }
    if (!this.isInside(dir)) throw new UserError(`Output directory ${shown} is outside the allowed root. Nothing was written.`, "OUTPUT_DIR_CHANGED");
    let r;
    try {
      await testHooks.beforeOpen?.(dir);
      r = await fsCall({ op: "write", root: this.root, rootId: this.rootId, parts: this.partsOf(dir), base, ext }, bytes).catch((e) => {
        throw this.helperFailed(e, `Writing to "${shown}"`);
      });
    } finally {
      await testHooks.afterOpen?.(dir);
    }
    const err = r.h.error;
    if (!err) return path.join(dir, r.h.name!);
    if (err === "EEXHAUST") throw new UserError(`Too many existing files named ${base}-N.${ext} in "${shown}".`, "WRITE_FAILED");
    if (WRITE_CODES.has(err)) throw new UserError(`Could not write the output file in "${shown}" (${err}). Nothing was left behind.`, "WRITE_FAILED");
    throw new UserError(
      `Output directory "${shown}" disappeared or was replaced while writing. Nothing was written and no file was left behind. Make sure nothing else modifies the folder.`,
      "OUTPUT_DIR_CHANGED",
    );
  }
}
