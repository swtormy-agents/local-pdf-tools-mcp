# local-pdf-tools-mcp

Local stdio MCP server for PDF work on your own machine: `pdf_info`, `pdf_merge`, `pdf_split`, `pdf_organize` (reorder/rotate/remove pages), `images_to_pdf`. No network, no telemetry, nothing is uploaded.

Docs: [https://noclaudkit.com/pdf/](https://noclaudkit.com/pdf/)

Status: 0.1.1. All five tools run on the shared core `@local-pdf-tools/core` (the same code as the website), with end-to-end tests on the core's fixtures.

## Quick start
Requires Node.js 20 or newer. Pick one folder the server may use, for example `/Users/you/pdf-work` (it must not be your home folder or a filesystem root).

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=local-pdf-tools&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImxvY2FsLXBkZi10b29scy1tY3AiLCItLXJvb3QiLCIvVXNlcnMveW91L3BkZi13b3JrIl19)

After installing, change `--root` to your own folder (the button installs the example `--root /Users/you/pdf-work`).

### Cursor
Add this to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "local-pdf-tools": {
      "command": "npx",
      "args": ["-y", "local-pdf-tools-mcp", "--root", "/Users/you/pdf-work"]
    }
  }
}
```

### Claude Desktop
Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`). Restart Claude Desktop after editing.

```json
{
  "mcpServers": {
    "local-pdf-tools": {
      "command": "npx",
      "args": ["-y", "local-pdf-tools-mcp", "--root", "/Users/you/pdf-work"]
    }
  }
}
```

### Other clients
Run `npx -y local-pdf-tools-mcp --root <absolute-folder>` over stdio, or set `LOCAL_PDF_TOOLS_ROOT` instead of `--root`.

Paths: use an absolute path; `~` is not expanded and is refused. On Windows, escape backslashes in JSON (`"C:\\Users\\you\\pdf-work"`) or use forward slashes.

## Tools
| Tool | What it does | Main inputs |
|---|---|---|
| `pdf_info` | Page count | `input` |
| `pdf_merge` | Merge 2-50 PDFs in order | `inputs`, `outputDir`, `outputName?` |
| `pdf_split` | Split by ranges, every n pages, or extract pages | `input`, `outputDir`, `mode` (`ranges` / `every_n` / `extract`), `ranges` / `n` / `pages` |
| `pdf_organize` | Reorder, rotate, remove pages | `input`, `outputDir`, `order` or `delete`, `rotate?`, `outputName?` |
| `images_to_pdf` | JPEG/PNG to one PDF | `images`, `outputDir`, `pageSize?` (`fit`/`A4`/`Letter`), `marginMm?`, `outputName?` |

Paths are relative to the allowed root. Page numbers are 1-based. Outputs are always new files.

## Rules

### Allowed folder and file safety
- `--root <dir>` (or `LOCAL_PDF_TOOLS_ROOT`) is required. A filesystem root, your home directory, folders that contain it, and paths with an unexpanded `~` are refused. All paths must stay inside the root (symlinks are resolved).
- All paths are first checked lexically (`..`, absolute paths, NUL, Windows drive-relative / `:` / reserved names) and with realpath (an in-root symlink is allowed; one pointing outside the root is refused) before any file is opened.
- Every open, create and folder creation under the root then runs in a small helper process (`src/anchor.ts`, all operating systems). It enters the target folder one component at a time with `chdir` and checks each step relative to the folder it is already in: the component is a real folder (not a symlink or Windows junction), the folder entered has the device/inode it had, and its `..` is the previous folder. Every lookup after that is a single name relative to that verified folder (the same effect as `openat`), so a folder or a parent folder swapped for a symlink cannot redirect it. Only the helper changes its working directory; the server process never does. `/proc` is not needed.
- Inputs: opened by the helper with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`; it must be a regular file with exactly one name (hard links, `nlink > 1`, are refused with `PATH_CHANGED` because they can point at files outside the root) and the device/inode seen by the check. The size limit is checked before reading; the file is read through that handle only.
- Outputs are new files only (`name.pdf`, `name-1.pdf`, ...; free numbered names are found by scan; existing files are never overwritten), created by the helper with `O_CREAT|O_EXCL|O_NOFOLLOW` in the verified folder; nothing is overwritten. Missing output folders are created the same way. After writing (and `fsync`) the helper checks that the folder is still inside the root; if anything failed, it removes only the file it has just created, by name in the same verified folder. The helper announces the file name before creating it and reports its device/inode right after creating it, before writing any byte. If the helper is killed or times out mid-write, the server starts a new helper, which enters the folder the same verified way (no symlink or junction followed), checks that the folder is still inside the root, moves the name onto a freshly created placeholder with a random name, and deletes it only if it has the reported device/inode and the folder is still inside the root. Anything else is put back with a hard link, which never overwrites a file; if the name was taken again meanwhile, the other file is kept under the placeholder name and the message names it. Nothing that cannot be proven to be the server's own file is deleted: if the helper stopped between creating the file and reporting it, or the filesystem has no hard links (e.g. FAT/exFAT, some network drives), no cleanup is attempted. In those cases, and if the cleanup itself fails, the error message names the file that may remain (tested: timeout, kill mid-write, kill right after create, swaps during cleanup, no hard links).
- What is guaranteed: nothing outside the root is read, and no file or folder is created outside the root, even while another program swaps folders inside the root. Each helper request, and each server-side `realpath`/`stat` pre-check, has a 30 s time limit (`FS_TIMEOUT`; a timed-out helper is restarted; a hung pre-check is abandoned, its pending system call may stay blocked in the background).
- Limits: someone who can write inside the root can still move a file or folder out of it after the server has finished with it, or move a folder from outside into the root (its files are then read as part of the root at that moment). Opening a device or FIFO swapped in at the last moment may have open side effects, but nothing is read from it. Tests cover moving folders out of the root and back (leaf and parent folder) and moving an outside folder into the root, during concurrent reads and writes (`test/folderMoves.test.ts`): nothing outside the root is read, and outputs are complete files; a folder moved in is read and written as part of the root while it is there (the limit above). On Windows the checks rely on `lstat` reporting junctions and symlinks as links and on NTFS file IDs. Windows CI runs all directory race and refusal tests, including the TOCTOU stress test, with junctions (no privilege needed); tests with file symlinks run only if a runtime probe can create one (skipped on `EPERM`). Not tested on Windows: directory symbolic links (as opposed to junctions), FIFO/device cases, moving the output folder out of the root during a cleanup (Windows refuses to rename a folder that is a process's working directory), and the no-`/proc` run (Linux only). On Windows a create in a folder that is being renamed can fail with `WRITE_FAILED` instead of `OUTPUT_DIR_CHANGED`.
- Error messages name paths relative to the root only, never the absolute root or a location outside it.

### Privacy: what is removed from outputs
- Every output is a new document, rebuilt by the core: the page dict and `/Resources` keep only allowlisted keys, and for dictionaries recognised by type (fonts, ExtGState, Form/Image XObjects, patterns, shadings, functions, colour-space parameters) the keys below `/Resources` are allowlisted too; other page-description data is kept (see the core README). Data that rendering needs is kept with its bytes copied as is and could carry private data, for example font programs, `/ToUnicode` CMaps, ICC profiles, function and shading streams, page content streams and non-JPEG image data (this list is not complete; see the core README). `/Type`, `/S`, `/Subtype` and `/Filter` are resolved through indirect references before they are checked; a reference chain longer than 32 hops or cyclic fails with `PDF_INVALID`, and references to missing objects are treated as null (the reference may remain, with no data). Removed from the output: the document Info dictionary and catalog XMP metadata, JavaScript/Launch and other actions (also under nonstandard keys or in `/Resources`), OpenAction, attachments (incl. page `/AF`), form fields, XObject `/Metadata` or `/PieceInfo`; only http/https/mailto link annotations survive. JPEG EXIF (incl. GPS), XMP, IPTC and comments are stripped, both from images given to `images_to_pdf` and from JPEG images inside input PDFs. Known limitation: metadata inside JPEG 2000 (`JPXDecode`) images and inside inline images (`BI ... EI` in content streams) is NOT stripped, and text in content streams is copied as is (see the core README, [Security / Known limits](https://github.com/swtormy-agents/pdf-tools/blob/bf31e73b7fc578fcadd4a477d1ffc535c18343ea/README.md#security)). Do not rely on this tool to anonymize such files.
- Encrypted PDFs are refused (`PDF_ENCRYPTED`) and never decrypted.
- stdout carries only MCP JSON-RPC; library warnings go to stderr. The core does not write to stdout (pdf-lib's only `console.log`, in `FlateStream`, is unreachable, and the core has a test for that); the server still routes `console.log/info/debug/...` to stderr before it starts (`src/stdio.ts`) as defense in depth, and `test/stdio.test.ts` checks stdout of the bundled server.

### Limits
- Limits (owned by the core, same as the website, not configurable): 100 MB per file, 300 MB per call, 1000 pages per result (merge/organize output, each `pdf_split` output file), 50 files per call, 50 MP per image, 500 MB of decompressed PDF stream data per call (`TOO_LARGE`, reported as a possible decompression bomb). `pdf_split`: at most 50 output files (`TOO_MANY_FILES`) and 5000 pages over all output files together, repeats counted (`TOO_MANY_PAGES`); e.g. `every_n` 1000 on a 2000-page PDF works, `every_n` 1 on it does not (2000 files). A reversed range (`from` > `to`) is rejected by the argument schema before the core is called. Ranges are always closed `{from, to}` objects (the core's open string ranges such as `-3` or `5-` are not exposed).

### Tool details
- Page numbers in all tools are 1-based. `pdf_split` writes `<input>-p1-3.pdf`, `<input>-p5.pdf`, ... `pdf_organize` takes `order` (final sequence of ORIGINAL page numbers; pages not listed are removed), optional `rotate` (`[{"page":2,"degrees":90}]`, any multiple of 90, added to the current rotation and normalized by the core; entries for the same page are summed) and an optional `delete` shortcut (instead of `order`: all pages except these, in original order). A page may be repeated in `order` to duplicate it. `pdf_info` returns `{ pageCount }` (an encrypted PDF fails with `PDF_ENCRYPTED`). `images_to_pdf` applies EXIF orientation; `pageSize` is `fit` (default: each page has the size of its image), `A4` or `Letter` (portrait, image scaled to fit and centered; sizes come from the core's `PAGE_SIZES`); `marginMm` (0-50, default 0) is converted to points for the core (with `fit` the page grows by twice the margin). With the defaults the output is byte-for-byte the core's default output. The image type is detected from the file contents, not the extension (a PNG named `.jpg` works, HEIC is refused).

### Errors
- Error codes from the core: `PDF_ENCRYPTED`, `PDF_INVALID`, `PAGE_RANGE`, `TOO_LARGE`, `TOO_MANY_PAGES`, `TOO_MANY_FILES`, `IMAGE_TOO_LARGE`, `IMAGE_INVALID`, `UNSUPPORTED_IMAGE`; plus MCP-side errors, among them:

  | Code | Meaning |
  |---|---|
  | `PATH_OUTSIDE_ROOT` | the path (after `..` / absolute resolution) is outside the root |
  | `SYMLINK_OUTSIDE_ROOT` | the path resolves through a symlink to a location outside the root |
  | `PATH_CHANGED` | input refused: it is a hard link (`nlink > 1`), or the file/a folder in its path was replaced while it was being opened (device/inode differ from the checked path, or a symlink appeared at the last component); nothing was read |
  | `INPUT_NOT_FOUND` / `INPUT_NOT_FILE` | the input does not exist (also if it disappears during the open) / is not a regular file |
  | `OUTPUT_DIR_CHANGED` | the output folder was replaced or disappeared while writing; nothing was written and no file was left |
  | `FS_TIMEOUT` / `FS_HELPER_FAILED` | the filesystem did not answer within 30 s / the helper process stopped; the request was not completed. A file the helper had already created is removed by a new helper only if it still has the same device/inode and its folder is inside the root; otherwise (or if this cannot be checked, e.g. no hard-link support) nothing is deleted and the message names the file that may remain |
  | `BAD_ARGS`, `BAD_OUTPUT_NAME`, `PATH_INVALID`, `WRITE_FAILED`, ... | invalid arguments / output problems |

## Development
```bash
npm ci --ignore-scripts
npm run build
npm test
npm run typecheck
npm run fixtures   # regenerate synthetic fixtures
```

## Core module
PDF operations come from the shared core `@local-pdf-tools/core` (Ryan Foster; public MIT repo `swtormy-agents/pdf-tools`), a devDependency pinned to a full commit sha (`github:swtormy-agents/pdf-tools#<sha>`, plain ESM JavaScript with types, no build step). `src/core/index.ts` is the only place that imports its functions; `src/core/types.ts` re-exports its types.

Division of work:
- Core: all PDF/image work; owns `LIMITS` and `ERROR_CODES` (no override); enforces the page/part limits and the decompression cap, rebuilds pages and resources from a key allowlist (document-level metadata, JavaScript, attachments and forms removed; some embedded data is kept, see Rules above), cleans up `/Annots`, strips JPEG APPn/COM (also in images inside PDFs), detects the image type by signature and checks image headers (`IMAGE_TOO_LARGE`, `IMAGE_INVALID`, `UNSUPPORTED_IMAGE`). The MCP layer does not duplicate any of this.
- MCP layer: allowed root and path checks, file count/size pre-check before reading (same `LIMITS` values), 1-based tool arguments converted to the core's 0-based indexes (`src/adapter.ts`), `every_n` ranges, output file naming, never-overwrite writes, error messages (`src/errorMap.ts`: names the failing input of a multi-file call from the core's `details.index`, and phrases `PAGE_RANGE` in 1-based words from the core's structured `details`, never from its message).

To move to a newer core: `npm install -D "github:swtormy-agents/pdf-tools#<full-sha>"` (never a branch), `npm run notices`, `npm test`.

## Build and release
`npm run build` (`scripts/build.mjs`) bundles `src/` with esbuild into `dist/` (ESM, node20), inlining `@local-pdf-tools/core`, `pdf-lib` and pdf-lib's dependencies. `@modelcontextprotocol/sdk` and `zod` stay regular npm dependencies, so the published package has no git dependency. `THIRD_PARTY_NOTICES` (shipped in the package) is generated by `npm run notices` from the installed packages and the verbatim upstream texts in `scripts/licenses/` (pdfkit LICENSE, Christopher Brown MIT, Apache-2.0), cross-checked against the core's THIRD-PARTY.md; `test/release.test.ts` fails if it is out of date or misses a package inlined into the bundle, and checks `npm pack --dry-run`.

## License
MIT. See [LICENSE](./LICENSE). Third-party notices: [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES).
