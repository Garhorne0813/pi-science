import { packager } from "@electron/packager";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(desktopRoot, "out");
const paths = await packager({
  dir: desktopRoot,
  out: outputRoot,
  overwrite: true,
  asar: true,
  name: "Pi-Science",
  executableName: "pi-science",
  appBundleId: "science.pi.desktop",
  appCategoryType: "public.app-category.education",
  platform: process.platform,
  arch: process.arch,
  electronVersion: "43.4.1",
  extraResource: [join(desktopRoot, ".stage", "desktop-runtime")],
  ignore: [/^\/node_modules(?:\/|$)/, /^\/src(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/\.stage(?:\/|$)/, /^\/tsconfig\.json$/, /^\/vitest\.config\.ts$/],
  prune: false,
});

for (const path of paths) console.log(`Packaged desktop application: ${path}`);
