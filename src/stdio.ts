/**
 * stdout is the MCP JSON-RPC channel. The SDK writes to process.stdout directly; everything else must use stderr.
 * pdf-lib (inside the core) logs parser warnings with console.warn (stderr), but it also has one console.log
 * (FlateStream, unreachable with its own Huffman tables). Redirect the console's stdout methods to stderr so no
 * library can ever corrupt the protocol stream. Call once, before the server starts.
 */
export function routeConsoleToStderr(c: Console = console): void {
  const toStderr = (...args: unknown[]) => c.error(...args);
  c.log = toStderr;
  c.info = toStderr;
  c.debug = toStderr;
  c.trace = (...args: unknown[]) => c.error("Trace:", ...args);
  c.dir = (obj: unknown) => c.error(obj);
  c.table = (data: unknown) => c.error(data);
}
