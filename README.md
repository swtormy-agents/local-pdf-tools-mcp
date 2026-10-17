# local-pdf-tools-mcp (work in progress, not published)

Local stdio MCP server for PDF work on your own machine: `pdf_info`, `pdf_merge`, `pdf_split`, `pdf_organize` (reorder/rotate/delete pages), `images_to_pdf`. No network, no telemetry, nothing is uploaded.

Status: skeleton. Tools, schemas, file access rules and limits are in place; the PDF operations call a shared core module that is not wired in yet, so every tool currently answers `NOT_IMPLEMENTED`.

## Rules
- `--root <dir>` (or `LOCAL_PDF_TOOLS_ROOT`) is required. A filesystem root, your home directory, folders that contain it, and paths with an unexpanded `~` are refused. All paths must stay inside the root (symlinks are resolved).
- Outputs are new files only (`name.pdf`, `name-1.pdf`, ...). Nothing is overwritten or deleted, including on error paths.
- Encrypted PDFs are refused (`PDF_ENCRYPTED`) and never decrypted.
- Limits (same as the website): 100 MB per file, 300 MB per call, 1000 pages per result, 50 files per call, 50 MP per image.
- Error codes: `PDF_ENCRYPTED`, `PDF_INVALID`, `PAGE_RANGE`, `TOO_LARGE`, `TOO_MANY_PAGES`, `TOO_MANY_FILES`, `IMAGE_TOO_LARGE` (provisional), plus path errors (`PATH_OUTSIDE_ROOT`, ...).

## Development
```
npm ci --ignore-scripts
npm run build
npm test
npm run fixtures   # regenerate synthetic fixtures
```
The core is selected in `src/core/index.ts` (one import). Contract: `src/core/types.ts`.

MIT licensed.
