import { expect, it } from "vitest";
import source from "./WorkspaceRail.tsx?raw";

// The Rail is in the initial bundle, so a value import that reaches Radix, a route
// page, or the lazy panel chunks moves them into the eager graph and trips the
// bundle budget's lazy-only check. Type-only imports are erased and do not count.
// A bare `import "x"` has no binding but still loads the module, so it must be
// checked as well.
const FROM_IMPORT = /^import\b([^;]*?)\bfrom\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^import\s+["']([^"']+)["']/gm;
// A re-export has no local binding either, but it still pulls the module into
// the eager graph.
const RE_EXPORT = /^export\b[^;]*?\bfrom\s+["']([^"']+)["']/gm;

it("pins the eager Rail static-import allowlist", () => {
  const valueImports = [
    ...[...source.matchAll(FROM_IMPORT)]
      .filter((match) => !match[1].trim().startsWith("type "))
      .map((match) => match[2]),
    ...[...source.matchAll(SIDE_EFFECT_IMPORT)].map((match) => match[1]),
    ...[...source.matchAll(RE_EXPORT)].map((match) => match[1]),
  ].sort();
  expect(valueImports).toEqual([
    "../../lib/knowledge",
    "../../lib/ui",
    "../settings/settings-loading",
    "../ui/Icon",
    "./primary-section",
    "./workspace-navigation",
    "lucide-react",
    "react-i18next",
    "react-router-dom",
  ]);
});
