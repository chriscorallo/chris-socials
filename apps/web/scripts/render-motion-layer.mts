/**
 * Child-process entry for rendering the motion-graphics layer from the web app
 * (lib/motion-subprocess.ts). Run with tsx: `node --import tsx render-motion-layer.mts <in.json> <out.json>`.
 * Input: renderVisualsLayer's input. Output: its result (JSON). Exit code 0 = success.
 *
 * Why a child process: @chris/motion ships TypeScript source and drives Remotion (headless
 * Chrome + a webpack/rspack bundle). Inside the Next.js server neither can be imported (Node's
 * native ESM can't resolve the TS source's extensionless imports, and Remotion must never be
 * bundled into the app), so the web app's render shells out to this script — the same thing a
 * dedicated worker process does.
 */
import { readFile, writeFile } from "node:fs/promises";
import { renderVisualBake, renderVisualsLayer } from "@chris/motion";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: render-motion-layer.mts <input.json> <output.json>");
  process.exit(2);
}
const args = JSON.parse(await readFile(input, "utf8"));
// `op: "bake"` = one graphic for the editor preview (docs/decisions-pending/editor-rebuild.md).
const result = args.op === "bake" ? await renderVisualBake(args) : await renderVisualsLayer(args);
await writeFile(output, JSON.stringify(result));
process.exit(0);
