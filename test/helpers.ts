import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const FIXTURES = path.resolve(__dirname, "fixtures");

/**
 * Windows race tests may see WRITE_FAILED when create hits delete-pending. Only EPERM/EACCES are that case;
 * ENOSPC/EIO/other WRITE_FAILED must still fail the test (L1).
 */
export const WIN_WRITE_FAILED_ERRNO = /\((EPERM|EACCES)\)/;

export function winWriteFailedOk(message: string): boolean {
  return WIN_WRITE_FAILED_ERRNO.test(message);
}

export async function tmpRoot(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lptm-")));
}

/**
 * QA F8: directory links for race tests. On Windows a junction ("junction" type) needs no privilege, so the directory
 * swap/race tests run there with junctions; elsewhere a normal directory symlink.
 */
export const DIRLINK: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir";

let symProbe: Promise<boolean> | undefined;
/** Runtime probe: can this process create a file symlink? false only if the OS refuses with EPERM (no privilege). */
export function canSymlink(): Promise<boolean> {
  return (symProbe ??= (async () => {
    const d = await tmpRoot();
    try {
      await fs.writeFile(path.join(d, "t"), "");
      await fs.symlink(path.join(d, "t"), path.join(d, "l"), "file");
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
      throw e;
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  })());
}
