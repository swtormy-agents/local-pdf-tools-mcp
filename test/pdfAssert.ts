/** Helpers to inspect output PDFs with pdf-lib (updateMetadata:false, so loading never adds an Info dict). */
import fs from "node:fs/promises";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString } from "pdf-lib";
import { expect } from "vitest";

export async function loadPdf(file: string): Promise<PDFDocument> {
  return PDFDocument.load(await fs.readFile(file), { updateMetadata: false });
}

export const widths = (doc: PDFDocument) => doc.getPages().map((p) => Math.round(p.getWidth()));
export const rotations = (doc: PDFDocument) => doc.getPages().map((p) => p.getRotation().angle);

/** Every indirect object as text; streams decoded where pdf-lib can (Flate etc.), raw otherwise (DCT). */
export function allObjectText(doc: PDFDocument): string {
  const parts: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      parts.push(obj.dict.toString());
      let data: Uint8Array;
      try {
        data = decodePDFRawStream(obj).decode();
      } catch {
        data = obj.contents;
      }
      parts.push(Buffer.from(data).toString("latin1"));
    } else {
      parts.push(obj.toString());
    }
  }
  return parts.join("\n");
}

/** Raw bytes of every DCTDecode (JPEG) image stream. */
export function jpegStreams(doc: PDFDocument): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Filter")) === PDFName.of("DCTDecode")) out.push(obj.contents);
  }
  return out;
}

/** JPEG marker codes of all segments before the first SOS. */
export function jpegMarkers(b: Uint8Array): number[] {
  const markers: number[] = [];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    markers.push(m);
    if (m === 0xda) break;
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return markers;
}

/**
 * No Info dictionary, no XMP, no document-level JavaScript/attachments/forms/open action, and every annotation
 * is a Link with a single URI action to http(s)/mailto. Returns the surviving URIs.
 */
export function assertCleanPdf(doc: PDFDocument): string[] {
  expect(doc.context.trailerInfo.Info, "trailer /Info").toBeUndefined();
  for (const key of ["Metadata", "Names", "AcroForm", "OpenAction", "Outlines", "AA"]) {
    expect(doc.catalog.has(PDFName.of(key)), `catalog /${key}`).toBe(false);
  }
  const uris: string[] = [];
  for (const page of doc.getPages()) {
    expect(page.node.has(PDFName.of("AA")), "page /AA").toBe(false);
    expect(page.node.has(PDFName.of("Metadata")), "page /Metadata").toBe(false);
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      const a = annots.lookup(k, PDFDict);
      expect(a.get(PDFName.of("Subtype"))).toBe(PDFName.of("Link"));
      expect(a.has(PDFName.of("AA"))).toBe(false);
      expect(a.has(PDFName.of("Dest"))).toBe(false);
      const action = a.lookup(PDFName.of("A"), PDFDict);
      expect(action.get(PDFName.of("S"))).toBe(PDFName.of("URI"));
      expect(action.has(PDFName.of("Next"))).toBe(false);
      const uri = action.lookup(PDFName.of("URI"));
      expect(uri instanceof PDFString || uri instanceof PDFHexString).toBe(true);
      const text = (uri as PDFString | PDFHexString).decodeText();
      expect(text).toMatch(/^(https?:|mailto:)/i);
      uris.push(text);
    }
  }
  return uris;
}
