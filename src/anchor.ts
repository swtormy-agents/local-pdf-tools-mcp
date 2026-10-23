import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * Race-free identity of `<root>/<parts...>/<name>` on platforms without openat() in Node and without /proc/self/fd
 * (macOS, BSD, Windows, or Linux with the /proc check disabled).
 *
 * Every path-based check in the parent (lstat/realpath/stat of "<root>/rin/doc.pdf") traverses the intermediate
 * directories by NAME, so an ABA swap (rin -> symlink to outside -> rin) can make each individual check see whichever
 * phase it lands in. No sequence of path-based checks can prove the opened fd is the in-root entry.
 *
 * A helper child process makes the walk relative to an inode instead of a name: it chdir()s into each component and
 * verifies, relative to its cwd (no names above it are traversed again), that stat(".") is the component it lstat'ed
 * (not a symlink) and that stat("..") is the previous verified directory. Once cwd is the verified directory inode,
 * lstat(name) is resolved inside that inode (openat semantics), so it returns the genuine in-root entry identity.
 * chdir is process-global, but only in the helper, which handles one request at a time with sync calls; the server
 * process keeps no global state.
 */
const HELPER = String.raw`
const fs = require("fs");
const id = (s) => s.dev + ":" + s.ino;
process.on("message", (m) => {
  let r;
  try {
    process.chdir(m.root);
    let prev = id(fs.statSync(".", { bigint: true }));
    if (prev !== m.rootId) throw Object.assign(new Error("root changed"), { code: "ELOOP" });
    const ids = [prev];
    for (const part of m.parts) {
      const l = fs.lstatSync(part, { bigint: true });
      if (l.isSymbolicLink() || !l.isDirectory()) throw Object.assign(new Error("not a dir"), { code: "ELOOP" });
      process.chdir(part);
      const here = fs.statSync(".", { bigint: true });
      if (id(here) !== id(l) || id(fs.statSync("..", { bigint: true })) !== prev) throw Object.assign(new Error("chain changed"), { code: "ELOOP" });
      prev = id(here);
      ids.push(prev);
    }
    const e = fs.lstatSync(m.name, { bigint: true });
    r = { id: m.id, ids, entry: id(e), isFile: e.isFile(), isSymlink: e.isSymbolicLink() };
  } catch (err) {
    r = { id: m.id, error: (err && err.code) || "EUNKNOWN" };
  }
  try { process.chdir(require("os").tmpdir()); } catch {}
  process.send(r);
});
`;

type Reply = { id: number; ids?: string[]; entry?: string; isFile?: boolean; isSymlink?: boolean; error?: string };

let child: ChildProcess | undefined;
let seq = 0;
const pending = new Map<number, (r: Reply) => void>();

function helper(): ChildProcess {
  if (child && child.connected) return child;
  const c = spawn(process.execPath, ["-e", HELPER], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json", windowsHide: true });
  c.on("message", (r: Reply) => {
    pending.get(r.id)?.(r);
    pending.delete(r.id);
    if (pending.size === 0) c.unref(), (c.channel as unknown as { unref?: () => void } | undefined)?.unref?.();
  });
  const fail = () => {
    if (child === c) child = undefined;
    for (const [k, res] of pending) res({ id: k, error: "EHELPER" });
    pending.clear();
  };
  c.on("exit", fail);
  c.on("error", fail);
  child = c;
  return c;
}

export type AnchoredEntry = { ids: string[]; entry: string; isFile: boolean; isSymlink: boolean };

/** Identity of root/parts/name resolved inode-relative by the helper; throws an errno-coded error on any change. */
export function anchoredLstat(root: string, rootId: { dev: bigint; ino: bigint }, rel: string, name: string): Promise<AnchoredEntry> {
  const parts = rel === "" ? [] : rel.split(path.sep);
  const c = helper();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (r) => {
      if (r.error) reject(Object.assign(new Error(`anchored lstat failed: ${r.error}`), { code: r.error }));
      else resolve(r as AnchoredEntry);
    });
    c.ref();
    (c.channel as unknown as { ref?: () => void } | undefined)?.ref?.();
    c.send({ id, root, rootId: `${rootId.dev}:${rootId.ino}`, parts, name });
  });
}

export const identKey = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`;
