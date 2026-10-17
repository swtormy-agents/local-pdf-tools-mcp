import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const FIXTURES = path.resolve(__dirname, "fixtures");

export async function tmpRoot(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lptm-")));
}
