/**
 * Bundle the MCP bridge into one file the app can ship.
 *
 * A packaged Bulletz previously carried no bridge at all: `files` listed the
 * compiled main and the icons, and nothing else. The agent could therefore
 * only ever reach a workspace when the chosen project folder happened to be
 * this repository — which is to say, on the author's machine and nowhere
 * else.
 *
 * One self-contained file avoids shipping @bulletz/mcp's node_modules into an
 * Electron bundle, and is run by Electron's own node (ELECTRON_RUN_AS_NODE),
 * so a user does not need node installed to have a working agent.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const out = join(here, "..", "assets", "mcp.mjs");

await build({
  entryPoints: [join(repo, "packages", "mcp", "src", "index.ts")],
  bundle: true,
  platform: "node",
  // ESM, because the server uses top-level await to connect its transport.
  format: "esm",
  target: "node22",
  outfile: out,
  logLevel: "error",
});

console.log(`  bundle-mcp: ${(statSync(out).size / 1024).toFixed(0)}KB -> assets/mcp.mjs`);
