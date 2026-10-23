import { constants as C } from "node:fs";
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

type Ident = { dev: bigint; ino: bigint };
/** One verified directory of a walked chain: absolute path, identity, and (POSIX) an open O_DIRECTORY fd pinning it. */
type ChainDir = { p: string; id: Ident; fh?: fs.FileHandle };

const DIR_FLAGS = C.O_RDONLY | (C.O_DIRECTORY ?? 0) | (C.O_NOFOLLOW ?? 0);

const looped = (msg: string) => Object.assign(new Error(msg), { code: "ELOOP" });

/**
 * chdir-free, component-by-component resolution (QA TOCTOU, Megan). No process-global state (no process.chdir), so
 * any number of concurrent tool calls may interleave at awaits safely. Node has no openat(), so each component of
 * root -> dir is checked by identity:
 * - lstat the prefix path: must be a real directory (not a symlink);
 * - POSIX: open it with O_RDONLY|O_DIRECTORY|O_NOFOLLOW, fstat the fd, require the lstat's dev/ino. The fd stays open
 *   until the call ends, so the inode cannot be freed and reused meanwhile (no inode-reuse ABA);
 * - "<dir>/.." must have the dev/ino of the previous chain entry (the chain is linked, not just a set of dirs).
 * Windows has neither O_DIRECTORY nor O_NOFOLLOW: lstat-only chain (symlinks there need admin/Developer Mode).
 */
async function walkDirs(root: string, dir: string): Promise<ChainDir[]> {
  const rel = path.relative(root, dir);
  const parts = rel === "" ? [] : rel.split(path.sep);
  const chain: ChainDir[] = [];
  let cur = root;
  try {
    for (let i = 0; i <= parts.length; i++) {
      if (i > 0) cur = path.join(cur, parts[i - 1]);
      const l = await fs.lstat(cur, { bigint: true });
      if (l.isSymbolicLink() || !l.isDirectory()) throw looped(`not a plain directory: ${cur}`);
      const entry: ChainDir = { p: cur, id: { dev: l.dev, ino: l.ino } };
      chain.push(entry);
      if (process.platform !== "win32") {
        entry.fh = await fs.open(cur, DIR_FLAGS);
        if (!sameFile(await entry.fh.stat({ bigint: true }), entry.id)) throw looped("directory changed");
      }
      if (i > 0 && !sameFile(await fs.stat(path.join(cur, ".."), { bigint: true }), chain[i - 1].id)) throw looped("directory chain changed");
    }
    return chain;
  } catch (e) {
    await closeChain(chain);
    throw e;
  }
}

/** Every directory of the chain still has the same identity at the same path (lstat, no symlink), fd included. */
async function chainIntact(chain: ChainDir[]): Promise<boolean> {
  try {
    for (const d of chain) {
      const l = await fs.lstat(d.p, { bigint: true });
      if (l.isSymbolicLink() || !sameFile(l, d.id)) return false;
      if (d.fh && !sameFile(await d.fh.stat({ bigint: true }), d.id)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function closeChain(chain: ChainDir[]): Promise<void> {
  await Promise.all(chain.map((d) => d.fh?.close().catch(() => undefined)));
  chain.length = 0;
}

/**
 * Open `name` inside the last directory of a verified chain. Linux: through /proc/self/fd/<dirfd>/<name>, which the
 * kernel resolves inside the pinned directory inode (an openat() equivalent), so a parent swap cannot redirect it.
 * Elsewhere by path; callers then verify the fd (identity + chain) before reading or writing anything.
 */
function openInChain(chain: ChainDir[], name: string, flags: number, mode?: number): Promise<fs.FileHandle> {
  const last = chain[chain.length - 1];
  if (process.platform === "linux" && !testHooks.noProcFd && last.fh) return fs.open(`/proc/self/fd/${last.fh.fd}/${name}`, flags, mode);
  return fs.open(path.join(last.p, name), flags, mode);
}

/** Linux: the real path of an open fd (/proc/self/fd). undefined elsewhere or when unavailable. */
async function procPath(fh: fs.FileHandle): Promise<string | undefined> {
  if (process.platform !== "linux" || testHooks.noProcFd) return undefined;
  return fs.readlink(`/proc/self/fd/${fh.fd}`).catch(() => undefined);
}

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
    let chain: ChainDir[] = [];
    try {
      chain = await walkDirs(this.root, path.dirname(real));
      fh = await openInChain(chain, path.basename(real), INPUT_FLAGS);
    } catch (e) {
      await closeChain(chain);
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
      // The final fd must be the entry at <verified dir>/<name>: lstat it directly (no realpath) and re-verify the
      // whole directory chain after it, so a parent swapped and swapped back around the open is detected.
      let entry: import("node:fs").BigIntStats;
      try {
        entry = await fs.lstat(real, { bigint: true });
      } catch {
        throw this.changed(p);
      }
      if (!sameFile(entry, st) || !(await chainIntact(chain))) throw this.changed(p);
      const actual = await procPath(fh);
      if (actual !== undefined && (actual.endsWith(" (deleted)") || !this.isInside(actual) || actual !== real)) throw this.changed(p);
      return { real, fh };
    } catch (e) {
      await fh.close();
      throw e;
    } finally {
      await closeChain(chain);
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
   * 2. walk and pin the directory chain from the root (walkDirs: lstat + O_DIRECTORY|O_NOFOLLOW fd + dev/ino + parent
   *    links), then create with O_CREAT|O_EXCL|O_NOFOLLOW in the verified dir (Linux: via /proc/self/fd/<dirfd>);
   * 3. BEFORE writing any data: lstat(<dir>/<name>) must be the fd's inode, the chain intact, (Linux) /proc agrees;
   *    otherwise nothing is written, the empty file is left (never unlinked by path) and the call fails;
   * 4. after writing, the same identity check again.
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
      let chain: ChainDir[] = [];
      try {
        // Create inside a directory verified component by component (no chdir), then verify the new fd BEFORE any
        // data is written: the chain is unchanged, <dir>/<name> is exactly our inode, and (Linux) /proc/self/fd agrees.
        chain = await walkDirs(this.root, dir);
        fh = await openInChain(chain, name, flags, 0o644);
        let ok = false;
        try {
          const st = await fh.stat({ bigint: true });
          const l = await fs.lstat(target, { bigint: true });
          ok = l.isFile() && sameFile(l, st) && (await chainIntact(chain));
        } catch {
          ok = false;
        }
        const actual = await procPath(fh);
        if (actual !== undefined && (actual.endsWith(" (deleted)") || path.dirname(actual) !== dir)) ok = false;
        moved = !ok;
        if (moved) {
          try {
            await this.verifyWritten(target, fh, true);
          } finally {
            await fh.close();
          }
        }
      } catch (e) {
        await closeChain(chain);
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
        await fh.close();  await closeChain(chain);
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
