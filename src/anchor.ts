import { spawn, type ChildProcess } from "node:child_process";

/**
 * Filesystem helper process: every filesystem operation that resolves a name under the allowed root runs here, on
 * every OS (QA F1-F4, Megan 87b1d7b). Node has no openat(); the helper gets the same semantics by chdir()ing into
 * the target directory one component at a time and verifying each step relative to its cwd:
 *   lstat(part) is a real directory (not a symlink / junction), chdir(part), stat(".") has the lstat's dev/ino and
 *   stat("..") is the previously verified directory.
 * From then on every lookup (open, mkdir, unlink) is a single name relative to the verified cwd inode, so a parent or
 * grandparent swapped for a symlink cannot redirect it: nothing is created or read outside the root, even
 * transiently. After the operation the helper climbs "..", "../..", ... and requires the verified identities again
 * (detects the cwd being renamed out of the root meanwhile); a created file is then removed by its relative name.
 *
 * chdir is process-global, so it happens only in this helper, which is synchronous and handles one request at a time.
 * The server process never calls chdir. No /proc is needed.
 *
 * IPC: length-prefixed binary frames over stdin/stdout: u32le header length, u32le payload length, JSON header,
 * raw payload (file bytes). Each request has a timeout; on timeout the helper is killed and respawned on next use.
 */
const HELPER = String.raw`
"use strict";
const fs = require("fs"), os = require("os");
const C = fs.constants, NOFOLLOW = C.O_NOFOLLOW || 0, NONBLOCK = C.O_NONBLOCK || 0;
const sab = new Int32Array(new SharedArrayBuffer(4));
const nap = () => Atomics.wait(sab, 0, 0, 2);
function readFull(n) {
  const b = Buffer.allocUnsafe(n); let o = 0;
  while (o < n) {
    let r;
    try { r = fs.readSync(0, b, o, n - o, null); } catch (e) { if (e.code === "EAGAIN") { nap(); continue; } if (e.code === "EOF") process.exit(0); throw e; }
    if (r === 0) process.exit(0);
    o += r;
  }
  return b;
}
function writeAll(b) {
  let o = 0;
  while (o < b.length) { try { o += fs.writeSync(1, b, o, b.length - o); } catch (e) { if (e.code === "EAGAIN") { nap(); continue; } throw e; } }
}
function send(h, p) {
  const hb = Buffer.from(JSON.stringify(h)), pre = Buffer.alloc(8);
  pre.writeUInt32LE(hb.length, 0); pre.writeUInt32LE(p ? p.length : 0, 4);
  writeAll(p && p.length ? Buffer.concat([pre, hb, p]) : Buffer.concat([pre, hb]));
}
const B = { bigint: true };
const id = (s) => s.dev + ":" + s.ino;
const E = (code, extra) => Object.assign(new Error(code), { code }, extra);
function enter(m, create) {
  process.chdir(m.root);
  let prev = id(fs.statSync(".", B));
  if (prev !== m.rootId) throw E("ECHANGED");
  const ids = [prev];
  for (const part of m.parts) {
    let l;
    try { l = fs.lstatSync(part, B); } catch (e) {
      if (e.code !== "ENOENT" || !create) throw e;
      try { fs.mkdirSync(part); } catch (e2) { if (e2.code !== "EEXIST") throw e2; }
      l = fs.lstatSync(part, B);
    }
    if (l.isSymbolicLink()) throw E("ELOOP");
    if (!l.isDirectory()) throw E("ENOTDIR");
    process.chdir(part);
    const here = fs.statSync(".", B);
    if (id(here) !== id(l) || id(fs.statSync("..", B)) !== prev) throw E("ECHANGED");
    prev = id(here); ids.push(prev);
  }
  return ids;
}
function under(ids) {
  let p = ".";
  for (let i = ids.length - 1; i >= 0; i--) { if (id(fs.statSync(p, B)) !== ids[i]) return false; p = p === "." ? ".." : p + "/.."; }
  return true;
}
function same(name, st) { try { const l = fs.lstatSync(name, B); return !l.isSymbolicLink() && id(l) === id(st); } catch { return false; } }
function read(m) {
  const ids = enter(m, false);
  const fd = fs.openSync(m.name, C.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const st = fs.fstatSync(fd, B);
    if (!st.isFile()) throw E("ENOTFILE");
    if (st.nlink > 1n) throw E("EHARDLINK", { nlink: Number(st.nlink) });
    if ((m.expect && id(st) !== m.expect) || !same(m.name, st)) throw E("ECHANGED");
    const size = Number(st.size);
    if (m.max >= 0 && size > m.max) throw E("ETOOLARGE", { size });
    const buf = Buffer.allocUnsafe(size); let o = 0;
    while (o < size) { const r = fs.readSync(fd, buf, o, size - o, o); if (r === 0) break; o += r; }
    if (!same(m.name, st) || !under(ids)) throw E("ECHANGED");
    return [{ ok: true }, buf.subarray(0, o)];
  } finally { fs.closeSync(fd); }
}
function write(m, data) {
  const ids = enter(m, false);
  for (let i = 0; i < 10000; i++) {
    const name = i === 0 ? m.base + "." + m.ext : m.base + "-" + i + "." + m.ext;
    let fd;
    try { fd = fs.openSync(name, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, 0o644); } catch (e) { if (e.code === "EEXIST" || e.code === "ELOOP") continue; throw e; }
    const st = fs.fstatSync(fd, B);
    let open = true;
    try {
      if (!same(name, st) || !under(ids)) throw E("ECHANGED");
      let o = 0;
      while (o < data.length) o += fs.writeSync(fd, data, o, data.length - o);
      fs.fsyncSync(fd);
      fs.closeSync(fd); open = false;
      if (!same(name, st) || !under(ids)) throw E("ECHANGED");
      return [{ ok: true, name }];
    } catch (e) {
      if (open) try { fs.closeSync(fd); } catch {}
      // Our own new file, removed by its relative name in the verified cwd, only if the name is still our inode.
      if (same(name, st)) try { fs.unlinkSync(name); } catch {}
      throw e;
    }
  }
  throw E("EEXHAUST");
}
function handle(m, p) {
  if (m.op === "read") return read(m);
  if (m.op === "write") return write(m, p);
  if (m.op === "mkdirs") { enter(m, true); return [{ ok: true }]; }
  if (m.op === "ping") { if (m.ms) Atomics.wait(sab, 0, 0, m.ms); return [{ ok: true }]; }
  throw E("EBADOP");
}
for (;;) {
  const pre = readFull(8);
  const hl = pre.readUInt32LE(0), pl = pre.readUInt32LE(4);
  const m = JSON.parse(readFull(hl).toString());
  const p = pl ? readFull(pl) : Buffer.alloc(0);
  let r;
  try { r = handle(m, p); } catch (e) { r = [{ error: (e && e.code) || "EUNKNOWN", size: e && e.size, nlink: e && e.nlink }]; }
  try { process.chdir(os.tmpdir()); } catch {}
  send(r[0], r[1]);
}
`;

export type FsHeader = { ok?: boolean; error?: string; name?: string; size?: number; nlink?: number };
export type FsReply = { h: FsHeader; p: Buffer };

/** Per-request timeout (ms). Exported setter for tests. */
let timeoutMs = 30_000;
export function setFsTimeout(ms: number): void {
  timeoutMs = ms;
}

type Current = { resolve: (r: FsReply) => void; reject: (e: Error) => void };
let child: ChildProcess | undefined;
let current: Current | undefined;
let chunks: Buffer[] = [];
let buffered = 0;

const fsError = (code: string) => Object.assign(new Error(`filesystem helper: ${code}`), { code });

function idle(c: ChildProcess, busy: boolean): void {
  const f = busy ? "ref" : "unref";
  c[f]();
  (c.stdout as unknown as { [k: string]: () => void } | null)?.[f]?.();
  (c.stdin as unknown as { [k: string]: () => void } | null)?.[f]?.();
}

function tryFrame(): void {
  if (!current || buffered < 8) return;
  const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  chunks = [all];
  const hl = all.readUInt32LE(0), pl = all.readUInt32LE(4);
  if (all.length < 8 + hl + pl) return;
  const h = JSON.parse(all.subarray(8, 8 + hl).toString()) as FsHeader;
  const p = Buffer.from(all.subarray(8 + hl, 8 + hl + pl));
  const rest = all.subarray(8 + hl + pl);
  chunks = rest.length ? [rest] : [];
  buffered = rest.length;
  const c = current;
  current = undefined;
  c.resolve({ h, p });
}

function helper(): ChildProcess {
  if (child) return child;
  const c = spawn(process.execPath, ["-e", HELPER], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  chunks = [];
  buffered = 0;
  c.stdout!.on("data", (d: Buffer) => {
    if (child !== c) return;
    chunks.push(d);
    buffered += d.length;
    tryFrame();
  });
  c.stdin!.on("error", () => undefined);
  const gone = () => {
    if (child !== c) return;
    child = undefined;
    const cur = current;
    current = undefined;
    cur?.reject(fsError("EHELPER"));
  };
  c.on("exit", gone);
  c.on("error", gone);
  child = c;
  return c;
}

function run(header: object, payload?: Uint8Array): Promise<FsReply> {
  return new Promise((resolve, reject) => {
    const c = helper();
    idle(c, true);
    const done = () => {
      clearTimeout(timer);
      if (child === c) idle(c, false);
    };
    const timer = setTimeout(() => {
      if (child === c) child = undefined;
      current = undefined;
      c.kill("SIGKILL");
      reject(fsError("FS_TIMEOUT"));
    }, timeoutMs);
    current = {
      resolve: (r) => (done(), resolve(r)),
      reject: (e) => (done(), reject(e)),
    };
    const hb = Buffer.from(JSON.stringify(header));
    const pre = Buffer.alloc(8);
    pre.writeUInt32LE(hb.length, 0);
    pre.writeUInt32LE(payload ? payload.byteLength : 0, 4);
    c.stdin!.write(pre);
    c.stdin!.write(hb);
    if (payload && payload.byteLength) c.stdin!.write(payload);
  });
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * One helper request (serialized: the helper is single-threaded and uses chdir). Rejects with code FS_TIMEOUT (helper
 * killed, respawned on the next call) or EHELPER (helper crashed); the operation's own errno comes back in `h.error`.
 */
export function fsCall(header: object, payload?: Uint8Array): Promise<FsReply> {
  const r = tail.then(() => run(header, payload));
  tail = r.catch(() => undefined);
  return r;
}

export const identKey = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`;
