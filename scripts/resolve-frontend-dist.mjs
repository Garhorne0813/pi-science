#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function resolveFrontendDist(root, value) {
  return resolve(root, value || "frontend/dist");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(resolveFrontendDist(fileURLToPath(new URL("../", import.meta.url)), process.argv[2]));
}
