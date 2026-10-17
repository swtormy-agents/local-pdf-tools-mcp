# local-pdf-tools-mcp (work in progress, not published)

Local stdio MCP server for PDF work on your own machine: `pdf_info`, `pdf_merge`, `pdf_split`, `pdf_organize` (reorder/rotate/remove pages), `images_to_pdf`. No network, no telemetry, nothing is uploaded.

Status: skeleton. Tools, schemas, file access rules and limits are in place; the PDF operations call a shared core module that is not wired in yet, so every tool currently answers `NOT_IMPLEMENTED`.

## Rules
- `--root <dir>` (or `LOCAL_PDF_TOOLS_ROOT`) is required. A filesystem root, your home directory, folders that contain it, and paths with an unexpanded `~` are refused. All paths must stay inside the root (symlinks are resolved).
- Outputs are new files only (`name.pdf`, `name-1.pdf`, ...). Nothing is overwritten or deleted, including on error paths.
- Encrypted PDFs are refused (`PDF_ENCRYPTED`) and never decrypted.
- Limits (owned by the core, same as the website, not configurable): 100 MB per file, 300 MB per call, 1000 pages per result, 50 files per call, 50 MP per image.
- Page numbers in all tools are 1-based. `pdf_split` writes `<input>-p1-3.pdf`, `<input>-p5.pdf`, ... `pdf_organize` takes `order` (final sequence of ORIGINAL page numbers; pages not listed are removed), optional `rotate` (`[{"page":2,"degrees":90}]`, multiples of 90, added to the current rotation) and an optional `delete` shortcut (instead of `order`: all pages except these, in original order).
- Error codes from the core: `PDF_ENCRYPTED`, `PDF_INVALID`, `PAGE_RANGE`, `TOO_LARGE`, `TOO_MANY_PAGES`, `TOO_MANY_FILES`, `IMAGE_TOO_LARGE`, `IMAGE_INVALID`, `UNSUPPORTED_IMAGE`, `NOT_IMPLEMENTED`; plus MCP-side errors (`PATH_OUTSIDE_ROOT`, `BAD_ARGS`, ...).

## Development
```
npm ci --ignore-scripts
npm run build
npm test
npm run typecheck
npm run fixtures   # regenerate synthetic fixtures
```

## Core module
PDF operations come from the shared core `@local-pdf-tools/core` (git dependency `github:swtormy-agents/pdf-tools#<sha>`, package at the repo root, ESM with types). It is not pushed yet, so `src/core/stub.ts` is wired in and answers `NOT_IMPLEMENTED`. Contract (mirrored by hand until then): `src/core/types.ts`.

Division of work:
- Core: all PDF/image work; owns `LIMITS` and `ERROR_CODES` (no override, limits are not passed in); enforces the 1000-page result limit, strips metadata, cleans up `/Annots`, checks image headers (`IMAGE_TOO_LARGE`, `IMAGE_INVALID`, `UNSUPPORTED_IMAGE`). The MCP layer does not duplicate any of this.
- MCP layer: allowed root and path checks, file count/size pre-check before reading (same `LIMITS` values), 1-based tool arguments converted to the core's 0-based indices (`src/adapter.ts`), output file naming, never-overwrite writes, error messages (`src/errorMap.ts`).
- `split(bytes, spec)` returns `[{ pages /* 1-based */, bytes }]`; `organize(bytes, { order, rotate? })` uses 0-based indices of ORIGINAL pages, empty `order` gives `PAGE_RANGE`.

Swap from the stub to the real core (one PR, when Ryan gives the commit sha):
1. `npm install "github:swtormy-agents/pdf-tools#<full-sha>"` (pinned sha, never a branch).
2. `src/core/index.ts`: replace the stub import with `@local-pdf-tools/core`.
3. `src/limits.ts`: `export { LIMITS } from "@local-pdf-tools/core"`; `src/errors.ts`: use the core's `ERROR_CODES`.
4. Replace hand-written types in `src/core/types.ts` with the core's types; add fixture-based tests from `@local-pdf-tools/core/fixtures` (see `test/fixtures/README.md`).

MIT licensed.
