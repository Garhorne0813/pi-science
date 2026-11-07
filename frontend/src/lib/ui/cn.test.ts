import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cn } from "./cn";

/** The `ui-*` steps are font sizes (tailwind.config.js `fontSize.ui-*`), so
 *  they must merge with colour classes instead of replacing them. */
const uiSizes = ["text-ui-micro", "text-ui-meta", "text-ui-caption", "text-ui-label", "text-ui-body", "text-ui-title"];

/** Read from the config rather than restating the list: a seventh step added there and
 *  forgotten in `cn.ts` is exactly the regression this file exists to prevent. */
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fontSizeBlock = /fontSize:\s*\{([\s\S]*?)\n\s*\},/.exec(readFileSync(path.join(frontendRoot, "tailwind.config.js"), "utf8"))?.[1] ?? "";
const declaredSizes = [...fontSizeBlock.matchAll(/"ui-[a-z0-9-]+":/g)].map((match) => match[0].slice(1, -2));

describe("cn", () => {
  it("keeps a ui font size and a text colour together, whichever order they arrive in", () => {
    expect(cn("text-ui-label", "text-muted")).toBe("text-ui-label text-muted");
    expect(cn("text-muted", "text-ui-label")).toBe("text-muted text-ui-label");
  });

  it("still lets a later font size win over an earlier one", () => {
    expect(cn("text-sm", "text-ui-label")).toBe("text-ui-label");
    expect(cn("text-ui-label", "text-sm")).toBe("text-sm");
  });

  it("keeps every ui step next to a colour class", () => {
    for (const size of uiSizes) {
      expect(cn(size, "text-muted")).toBe(`${size} text-muted`);
      expect(cn("text-muted", size)).toBe(`text-muted ${size}`);
    }
  });

  it("covers every ui-* step the tailwind config declares", () => {
    expect(declaredSizes.length).toBeGreaterThanOrEqual(6);
    for (const size of declaredSizes) {
      expect(cn(`text-${size}`, "text-muted")).toBe(`text-${size} text-muted`);
    }
  });

  it("keeps the default tailwind font sizes working", () => {
    expect(cn("text-xs", "text-muted")).toBe("text-xs text-muted");
    expect(cn("text-muted", "text-xs")).toBe("text-muted text-xs");
  });
});
