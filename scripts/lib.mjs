/**
 * The demo's shared plumbing: where things live, how the lane is built, and
 * how it is run.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const rustDir = join(root, "rust");
export const publicDir = join(root, "public");
export const distDir = join(root, "dist");
export const laneBinary = join(rustDir, "target", "release", "mlp-demo-lane");

/** Build the lane: the demo's Rust half, the one that calls the protocol. */
export function buildLane({ locked = false } = {}) {
  const args = ["build", "--release"];
  if (locked) {
    args.push("--locked");
  }
  const result = spawnSync("cargo", args, { cwd: rustDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`cargo build failed with status ${String(result.status)}`);
  }
}

/** Start the lane. It speaks its line protocol on stdout and stdin. */
export function startLane() {
  if (!existsSync(laneBinary)) {
    throw new Error(`the lane is not built: ${laneBinary} is missing`);
  }
  mkdirSync(publicDir, { recursive: true });
  return spawn(laneBinary, [], { stdio: ["pipe", "pipe", "inherit"] });
}
