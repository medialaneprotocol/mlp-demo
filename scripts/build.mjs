/**
 * Bundle the browser page and the headless receiver.
 *
 * The protocol's package ships TypeScript sources, so both hosts need a
 * bundle: the browser needs one script, and the headless run needs one module
 * it can import.
 */

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { distDir, publicDir, root } from "./lib.mjs";

mkdirSync(distDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

await build({
  entryPoints: [join(root, "web", "app.ts")],
  outfile: join(publicDir, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  logLevel: "warning",
});

await build({
  entryPoints: [join(root, "web", "receiver.ts")],
  outfile: join(distDir, "receiver.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  logLevel: "warning",
});

await build({
  entryPoints: [join(root, "web", "budgets.ts")],
  outfile: join(distDir, "budgets.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  logLevel: "warning",
});

copyFileSync(join(root, "web", "index.html"), join(publicDir, "index.html"));

console.log("built public/app.js, public/index.html, dist/receiver.mjs and dist/budgets.mjs");
