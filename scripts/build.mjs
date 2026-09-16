#!/usr/bin/env node

import { chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "plugins", "unblock", "scripts", "unblock.mjs");

await build({
  entryPoints: [path.join(root, "src", "unblock.mjs")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  sourcemap: false,
  legalComments: "none",
});
await chmod(output, 0o755);
