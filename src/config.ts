import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserError } from "./errors.js";

export interface Config {
  allowedRoot: string;
}

const BOOLEAN_FLAGS = new Set<string>([]);



/** realpath of the deepest existing ancestor, with the missing tail appended (so both sides compare consistently). */
function realOrResolved(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function sameOrAncestor(ancestor: string, p: string): boolean {
  const norm = (x: string) => (process.platform === "win32" ? x.toLowerCase() : x);
  const rel = path.relative(norm(ancestor), norm(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Refuse obviously dangerous roots: a filesystem root ("/", "C:\\"), the home directory, or any ancestor of it
 * (e.g. /home, /Users). Both sides are compared after realpath, so symlinked homes are caught too.
 * `homes` is injectable for tests; by default os.homedir(), $HOME and %USERPROFILE%.
 */
export function assertSafeRoot(root: string, homes: string[] = [os.homedir(), process.env.HOME ?? "", process.env.USERPROFILE ?? ""]): void {
  const r = realOrResolved(root);
  if (path.parse(r).root === r) {
    throw new UserError(`Refusing to use the filesystem root (${r}) as the allowed root. Pass a specific folder, e.g. --root ~/Documents/pdf-work.`, "ROOT_TOO_BROAD");
  }
  for (const h of homes.filter(Boolean)) {
    const home = realOrResolved(h);
    if (sameOrAncestor(r, home)) {
      throw new UserError(
        `Refusing to use ${r} as the allowed root: it is your home directory or contains it (${home}). Pass a specific folder inside your home, e.g. --root ~/Documents/pdf-work.`,
        "ROOT_TOO_BROAD",
      );
    }
  }
}

/**
 * Configuration comes from CLI flags (preferred) or environment variables.
 *   --root <dir>            / LOCAL_PDF_TOOLS_ROOT            (REQUIRED, no default)
 * Limits are owned by the core module (LIMITS, see limits.ts) and match the website; they are not configurable.
 */
export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), homes?: string[]): Config {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UserError(`Unexpected argument "${a}". Options start with --, e.g. --root /path/to/folder.`, "BAD_CONFIG");
    const eq = a.indexOf("=");
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(a.slice(2))) flags[a.slice(2)] = "true";
    else if (i + 1 < argv.length) flags[a.slice(2)] = argv[++i];
    else throw new UserError(`Option ${a} needs a value.`, "BAD_CONFIG");
  }
  const root = flags["root"] ?? env.LOCAL_PDF_TOOLS_ROOT;
  if (!root || !root.trim()) {
    throw new UserError(
      "No allowed root directory configured. Start the server with --root /absolute/path/to/folder (or set LOCAL_PDF_TOOLS_ROOT). The server only reads and writes inside that folder.",
      "ROOT_REQUIRED",
    );
  }
  if (/^~([\\/]|$)/.test(root.trim()) || /^~[A-Za-z0-9._-]+([\\/]|$)/.test(root.trim())) {
    throw new UserError(
      `The root "${root}" starts with "~", which was not expanded by a shell (e.g. it was quoted or set in a JSON config). Use the full absolute path instead, e.g. /Users/you/Documents/pdf-work.`,
      "ROOT_TILDE",
    );
  }
  const allowedRoot = path.resolve(cwd, root);
  assertSafeRoot(allowedRoot, homes ?? [os.homedir(), env.HOME ?? "", env.USERPROFILE ?? ""]);
  return { allowedRoot };
}
