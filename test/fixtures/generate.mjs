// Generates synthetic test fixtures (no third-party content). Output is dedicated to the public domain (CC0 1.0).
// Run: npm run fixtures
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Minimal valid PDF with `n` empty A4 pages, built by hand with a correct xref table. */
export function minimalPdf(n = 1) {
  const objs = [];
  const kids = Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>");
  let out = "%PDF-1.7\n";
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.writeFileSync(path.join(dir, "one-page.pdf"), minimalPdf(1));
  fs.writeFileSync(path.join(dir, "three-pages.pdf"), minimalPdf(3));
  fs.writeFileSync(path.join(dir, "not-a-pdf.pdf"), "this is plain text, not a PDF\n");
  console.log("fixtures written to", dir);
}
