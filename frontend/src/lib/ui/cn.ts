/** CSS class name utility using clsx + tailwind-merge. */

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** `text-ui-*` are the project's own font-size steps (`tailwind.config.js`
 *  `fontSize`), not colours. Without this registration tailwind-merge reads
 *  `text-ui-label` as a text colour, puts it in the same conflict group as
 *  `text-muted`, and silently drops whichever came first. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{
        text: ["ui-micro", "ui-meta", "ui-caption", "ui-label", "ui-body", "ui-title"],
      }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
