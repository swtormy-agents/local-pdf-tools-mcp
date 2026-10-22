import { constants as C } from "node:fs";
import { closeSync, openSync } from "node:fs";
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

function dirChanged(p: string, e: unknown): Error {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new UserError(`Output directory "${p}" changed or disappeared while it was being prepared. Nothing was written.`, "OUTPUT_DIR_CHANGED");
  }
  return e as Error;
}

/** Test-only hooks to simulate races (e.g. swapping a directory for a symlink). Never set in production. */
export const testHooks: {
  /** Called after output dir resolution, before the pre-write re-check (simulates a slow decode). */
  beforeWrite?: (dir: string) => Promise<void> | void;
  /** Called after the pre-write re-check, immediately before open() (simulates the tightest race). */
  beforeOpen?: (dir: string) => Promise<void> | void;
  /** Called right after open(), before writing (e.g. to swap the directory back). */
  afterOpen?: (dir: string) => Promise<void> | void;
  /** Called after a failed write, after truncation and before the file is located for the error message. */
  beforeCleanup?: (dir: string) => Promise<void> | void;
  /** Input side: called after the realpath/stat check, immediately before the input file is opened. */
  beforeInputOpen?: (real: string) => Promise<void> | void;
  /** Input side: called right after the input file was opened, before the post-open checks. */
  afterInputOpen?: (real: string) => Promise<void> | void;
  /** Disable the Linux-only /proc/self/fd checks, so Linux CI exercises the same checks as macOS/BSD. */
  noProcFd?: boolean;
} = {};

/** Flags for opening an input: no symlink at the last component, and never block on a FIFO/device swapped in. */
const INPUT_FLAGS = C.O_RDONLY | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0);

/** Exact identity of a file (bigint stats: Windows file indexes do not fit a double). */
const sameFile = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino;

/**
 * Open `name` relative to the directory `dir` *by directory identity*, not by path (TOCTOU fix, macOS CI race):
 * Node has no openat(), so we chdir into `dir` and open the bare name relative to the cwd. Once chdir succeeded the
 * kernel resolves `name` inside that directory inode, so swapping `dir` (or any parent) for a symlink afterwards cannot
 * redirect the open. process.cwd() right after chdir is the kernel's getcwd() of the directory we actually entered
 * (macOS/Linux/Windows), so a symlink swapped in *before* chdir is visible as a cwd outside the root. chdir(".")
 * after the open refreshes Node's cached cwd so a directory moved away during the open is seen too.
 * Fully synchronous (no await between chdir and restore), so no other request can observe the changed cwd.
 * `name` must be a single path component.
 */
function openInDir(dir: string, name: string, flags: number, mode?: number): { fd?: number; err?: unknown; cwdBefore: string; cwdAfter?: string } {
  const prev = process.cwd();
  let cwdBefore: string;
  try {
    process.chdir(dir);
  } catch (err) {
    return { err, cwdBefore: "" };
  }
  try {
    cwdBefore = process.cwd();
    if (gate && !gate(cwdBefore)) return { cwdBefore };
    let fd: number;
    try {
      fd = openSync(name, flags, mode);
    } catch (err) {
      return { err, cwdBefore };
    }
    process.chdir(".");
    return { fd, cwdBefore, cwdAfter: process.cwd() };
  } finally {
    process.chdir(prev);
  }
}
/**
 * Turn a raw fd from openInDir into a FileHandle (Node cannot wrap an fd): reopen /dev/fd/N, which on macOS dup()s the
 * descriptor and on Linux reopens the very same open file (never a path lookup of the original name), then require
 * the same dev/ino and close the raw fd.
 */
async function adoptFd(fd: number, flags: number): Promise<fs.FileHandle> {
  try {
    const fh = await fs.open(`/dev/fd/${fd}`, flags);
    const [a, b] = await Promise.all([fh.stat({ bigint: true }), fs.stat(`/dev/fd/${fd}`, { bigint: true })]);
    if (!sameFile(a, b)) {
      await fh.close();
      throw new Error("fd adoption mismatch");
    }
    return fh;
  } finally {
    closeSync(fd);
  }
}

/** Set by openInDir callers: refuse to open when the entered directory is not acceptable. */
let gate: ((cwd: string) => boolean) | undefined;

const errnoOf = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;

/**
 * Restricts all file access to one allowed root directory.
 * - Relative paths are resolved against the root.
 * - ".." traversal and absolute paths outside the root are rejected.
 * - Symlinks are resolved with realpath; a link that points outside the root is rejected.
 */
export class PathGuard {
  private constructor(public readonly root: string) {}

  static async create(root: string): Promise<PathGuard> {
    let real: string;
    try {
      real = await fs.realpath(root);
    } catch {
      throw new UserError(`Allowed root directory does not exist: ${root}. Set --root or LOCAL_PDF_TOOLS_ROOT to an existing directory.`, "ROOT_MISSING");
    }
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new UserError(`Allowed root is not a directory: ${root}.`, "ROOT_NOT_DIR");
    assertSafeRoot(real);
    return new PathGuard(real);
  }

  isInside(p: string): boolean {
    const rel = path.relative(this.root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  private lexical(p: string): string {
    if (typeof p !== "string" || p.length === 0) throw new UserError("Path must be a non-empty string.", "PATH_EMPTY");
    if (p.includes("\0")) throw new UserError("Path contains a NUL byte.", "PATH_INVALID");
    assertPortablePath(p);
    const abs = path.resolve(this.root, p);
    if (!this.isInside(abs)) {
      throw new UserError(`Path "${p}" is outside the allowed root (${this.root}). Use a path inside it, or restart the server with a different --root.`, "PATH_OUTSIDE_ROOT");
    }
    return abs;
  }

  private async real(abs: string, original: string): Promise<string> {
    const real = await fs.realpath(abs);
    if (!this.isInside(real)) {
      throw new UserError(`Path "${original}" resolves (via a symlink) to a location outside the allowed root. Symlinks may only point inside ${this.root}.`, "SYMLINK_OUTSIDE_ROOT");
    }
    return real;
  }

  private notFound(p: string, abs: string): UserError {
    return new UserError(`Input file not found: "${p}" (looked in ${abs}).`, "INPUT_NOT_FOUND");
  }

  /** The checked path no longer names the file that was opened (dev/ino mismatch, symlink swapped in). */
  private changed(p: string): UserError {
    return new UserError(
      `Input "${p}" changed while it was being opened (the file, a symlink or a folder in its path was replaced). It was not read. Make sure nothing else modifies the folder and try again.`,
      "PATH_CHANGED",
    );
  }

  /** Resolve an existing regular file for reading (path checks only; read through openInputFile). */
  async resolveInputFile(p: string): Promise<string> {
    return (await this.checkInputFile(p)).real;
  }

  /** realpath inside the root + stat (bigint identity) of an input that must be a regular file. */
  private async checkInputFile(p: string): Promise<{ abs: string; real: string; st: import("node:fs").BigIntStats }> {
    const abs = this.lexical(p);
    let real: string;
    let st: import("node:fs").BigIntStats;
    try {
      real = await this.real(abs, p);
      st = await fs.stat(real, { bigint: true });
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw this.notFound(p, abs);
    }
    if (!st.isFile()) throw new UserError(`Input "${p}" is not a regular file.`, "INPUT_NOT_FILE");
    return { abs, real, st };
  }

  /**
   * Open an input file for reading without a check-then-use race (QA M1):
   * 1. realpath must be inside the root; stat it (identity S1, must be a regular file);
   * 2. open that real path with O_RDONLY|O_NOFOLLOW|O_NONBLOCK (no symlink at the last component; a FIFO swapped in
   *    cannot block us);
   * 3. fstat the handle: it must be a regular file with nlink 1 (a hard link can point at a file outside the root)
   *    and the same dev/ino as S1;
   * 4. realpath the original path again: still inside the root, and lstat of it has the same dev/ino as the handle;
   *    on Linux the handle's own path (/proc/self/fd/N) must also be inside the root.
   * Any mismatch rejects the input; the caller reads through the returned handle only. Codes: PATH_CHANGED for a hard
   * link (nlink > 1), a dev/ino mismatch or a symlink swapped in at the last component (ELOOP); SYMLINK_OUTSIDE_ROOT
   * if the path now resolves outside the root; INPUT_NOT_FOUND if it vanished (ENOENT); INPUT_NOT_FILE for a non-file.
   * Windows has no O_NOFOLLOW: the open may follow a link at the last component, but steps 3-4 still compare the
   * opened file with the checked path, so a swapped link is rejected after the open instead of at it.
   */
  async openInputFile(p: string): Promise<{ real: string; fh: fs.FileHandle }> {
    const { abs, real, st: before } = await this.checkInputFile(p);
    await testHooks.beforeInputOpen?.(real);
    let fh: fs.FileHandle;
    try {
      if (process.platform === "win32") fh = await fs.open(real, INPUT_FLAGS);
      else {
      gate = (cwd) => this.isInside(cwd);
      const r = openInDir(path.dirname(real), path.basename(real), INPUT_FLAGS);
      gate = undefined;
      if (r.err) throw r.err;
      if (r.fd === undefined || !this.isInside(r.cwdBefore)) throw this.changed(p);
      if (r.cwdAfter === undefined || !this.isInside(r.cwdAfter)) {
        closeSync(r.fd);
        throw this.changed(p);
      }
      fh = await adoptFd(r.fd, C.O_RDONLY | (C.O_NONBLOCK ?? 0));
      }
    } catch (e) {
      gate = undefined;
      if (e instanceof UserError) throw e;
      const code = errnoOf(e);
      if (code === "ENOENT" || code === "ENOTDIR") throw this.notFound(p, abs);
      if (code === "ELOOP" || code === "EMLINK") throw this.changed(p);
      if (code === "ENXIO" || code === "EISDIR") throw new UserError(`Input "${p}" is not a regular file.`, "INPUT_NOT_FILE");
      throw e;
    }
    try {
      await testHooks.afterInputOpen?.(real);
      const st = await fh.stat({ bigint: true });
      if (!st.isFile()) throw new UserError(`Input "${p}" is not a regular file.`, "INPUT_NOT_FILE");
      if (st.nlink > 1n) {
        throw new UserError(
          `Input "${p}" is a hard link (${st.nlink} names for the same file). Hard links can point at files outside the allowed root, so they are refused. Copy the file into ${this.root} instead.`,
          "PATH_CHANGED",
        );
      }
      if (!sameFile(st, before)) throw this.changed(p);
      let again: string;
      let now: import("node:fs").BigIntStats;
      try {
        again = await fs.realpath(abs);
        now = await fs.lstat(again, { bigint: true });
      } catch {
        throw this.changed(p);
      }
      if (!this.isInside(again)) {
        throw new UserError(`Path "${p}" resolves (via a symlink) to a location outside the allowed root. Symlinks may only point inside ${this.root}.`, "SYMLINK_OUTSIDE_ROOT");
      }
      if (again !== real || !sameFile(now, st)) throw this.changed(p);
      if (process.platform === "linux" && !testHooks.noProcFd) {
        const actual = await fs.readlink(`/proc/self/fd/${fh.fd}`).catch(() => undefined);
        if (actual !== undefined && (actual.endsWith(" (deleted)") || !this.isInside(actual))) throw this.changed(p);
      }
      return { real, fh };
    } catch (e) {
      await fh.close();
      throw e;
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

  /**
   * Resolve (and create if needed) an output directory inside the root.
   * Each existing ancestor is checked with realpath so a symlinked parent cannot escape.
   */
  async resolveOutputDir(p: string): Promise<string> {
    const abs = this.lexical(p);
    // Find the deepest existing ancestor and verify it.
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
      throw dirChanged(p, e);
    }
    if (!st.isDirectory()) throw new UserError(`Output path "${p}" is not a directory.`, "OUTPUT_NOT_DIR");
    let out = realBase;
    for (const seg of missing) {
      out = path.join(out, seg);
      try {
        await fs.mkdir(out).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST") throw e;
        });
        out = await this.real(out, p);
      } catch (e) {
        if (e instanceof UserError) throw e;
        throw dirChanged(p, e);
      }
    }
    return out;
  }

  /**
   * Write `data` to a new file `<base>[-N].<ext>` in `dir` without overwriting anything and without escaping the root,
   * even if `dir` (or a parent) is swapped for a symlink while we work:
   * 1. right before opening, realpath(dir) again and require it to be unchanged and inside the root;
   * 2. open with O_CREAT|O_EXCL|O_NOFOLLOW (never follows a symlink at the target, never overwrites);
   * 3. after writing, realpath the new file and compare its device/inode with the open handle (fstat);
   *    if it is not the file we created inside the root, delete what we wrote and fail.
   */
  async writeNewFile(dir: string, base: string, ext: string, data: Buffer | ((fh: fs.FileHandle) => Promise<void>)): Promise<string> {
    if (isWindowsReserved(base)) base = `_${base}`;
    await testHooks.beforeWrite?.(dir);
    const flags = C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0);
    for (let i = 0; i < 10000; i++) {
      const name = i === 0 ? `${base}.${ext}` : `${base}-${i}.${ext}`;
      await this.assertDirUnchanged(dir);
      await testHooks.beforeOpen?.(dir);
      const target = path.join(dir, name);
      let fh: fs.FileHandle;
      let moved = false;
      try {
        if (process.platform === "win32") fh = await fs.open(target, flags, 0o644);
        else {
          // Create relative to the directory we actually entered (see openInDir), not by path: a parent swapped for a
          // symlink between the re-check and the open can no longer redirect the new file outside the root.
          gate = (cwd) => cwd === dir;
          const r = openInDir(dir, name, flags, 0o644);
          gate = undefined;
          if (r.err) throw r.err;
          if (r.fd === undefined) {
            throw new UserError(`Output directory ${dir} was replaced (now resolves to ${r.cwdBefore}) while converting. Nothing was written. Make sure nothing else modifies the folder.`, "OUTPUT_DIR_CHANGED");
          }
          moved = r.cwdAfter !== dir;
          fh = await adoptFd(r.fd, C.O_WRONLY);
        }
        // Verify via the fd BEFORE any data is written (Linux: /proc/self/fd names the real location of the new file).
        if (!moved && process.platform === "linux" && !testHooks.noProcFd) {
          const actual = await fs.readlink(`/proc/self/fd/${fh.fd}`).catch(() => undefined);
          if (actual !== undefined && (actual.endsWith(" (deleted)") || path.dirname(actual) !== dir)) moved = true;
        }
        if (moved) {
          try {
            await this.verifyWritten(target, fh, true);
          } finally {
            await fh.close();
          }
        }
      } catch (e) {
        gate = undefined;
        if (e instanceof UserError) throw e;
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ELOOP") continue;
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw new UserError(`Output directory ${dir} disappeared or was replaced while converting. Nothing was written. Make sure nothing else modifies the folder.`, "OUTPUT_DIR_CHANGED");
        }
        throw new UserError(`Could not create output file ${target}: ${(e as Error).message}`, "WRITE_FAILED");
      }
      try {
        await testHooks.afterOpen?.(dir);
        try {
          if (typeof data === "function") await data(fh);
          else await fh.writeFile(data);
        } catch (e) {
          // No partial data is kept (truncate via fd), but nothing is deleted by path (see leaveOwn).
          await this.leaveOwn(target, fh, e);
        }
        await this.verifyWritten(target, fh, moved);
      } finally {
        await fh.close();
      }
      return target;
    }
    throw new UserError(`Too many existing files named ${base}-N.${ext} in ${dir}.`, "WRITE_FAILED");
  }

  /** Best-effort current location of an open file (Linux: /proc/self/fd), for error messages only. Never used to delete. */
  private async locate(fh: fs.FileHandle, fallback: string): Promise<string> {
    if (process.platform === "linux") {
      try {
        return (await fs.readlink(`/proc/self/fd/${fh.fd}`)).replace(/ \(deleted\)$/, "");
      } catch {
        /* /proc not available */
      }
    }
    return fallback;
  }

  /**
   * After a failed write: never unlink anything by path (a name can be swapped between any check and the unlink).
   * Truncate through the open handle so no partial data remains, then report where the empty file is.
   */
  private async leaveOwn(target: string, fh: fs.FileHandle, cause: unknown): Promise<never> {
    await fh.truncate(0).catch(() => undefined);
    await testHooks.beforeCleanup?.(path.dirname(target));
    const where = await this.locate(fh, target);
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new UserError(
      `Writing the output failed (${why}). An empty output file was left at ${where}; it was not deleted automatically. Delete it if you do not need it.`,
      "WRITE_FAILED_FILE_LEFT",
    );
  }

  private async assertDirUnchanged(dir: string): Promise<void> {
    let real: string;
    try {
      real = await fs.realpath(dir);
    } catch {
      throw new UserError(`Output directory ${dir} disappeared while converting. Nothing was written.`, "OUTPUT_DIR_CHANGED");
    }
    if (real !== dir || !this.isInside(real)) {
      throw new UserError(`Output directory ${dir} was replaced (now resolves to ${real}) while converting. Nothing was written. Make sure nothing else modifies the folder.`, "OUTPUT_DIR_CHANGED");
    }
  }

  private async verifyWritten(target: string, fh: fs.FileHandle, moved = false): Promise<void> {
    const st = await fh.stat();
    const isOurs = async (p: string): Promise<boolean> => {
      try {
        const now = await fs.lstat(p);
        return now.isFile() && now.dev === st.dev && now.ino === st.ino;
      } catch {
        return false;
      }
    };
    let real: string | undefined;
    try {
      real = await fs.realpath(target);
    } catch {
      real = undefined;
    }
    if (!moved && real && this.isInside(real) && path.dirname(real) === path.dirname(target) && (await isOurs(real))) return;

    // The directory changed around open(): our file may be somewhere else, possibly outside the root.
    // Never unlink by path (the name can be swapped again before unlink). Empty it through the handle and report.
    await fh.truncate(0).catch(() => undefined);
    const where = process.platform === "linux" ? await this.locate(fh, "") : "";
    throw new UserError(
      where
        ? `Output directory changed during the write. An empty file was left at ${where} (possibly outside ${this.root}); it was not deleted automatically. Check what modified ${path.dirname(target)} and delete the file if needed.`
        : `Output directory changed during the write. An empty file may remain at an unknown location outside ${this.root}; it was not deleted automatically. Check what modified ${path.dirname(target)}.`,
      "OUTPUT_DIR_CHANGED_FILE_LEFT",
    );
  }

}
