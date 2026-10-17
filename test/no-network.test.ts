import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("no network", () => {
  it("source never imports network modules", () => {
    const dir = path.resolve(__dirname, "../src");
    const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const s = fs.readFileSync(path.join(dir, f), "utf8");
      expect(s, f).not.toMatch(/from "node:(http|https|net|dgram|tls|dns)"|\bfetch\(|XMLHttpRequest|WebSocket/);
    }
  });
});
