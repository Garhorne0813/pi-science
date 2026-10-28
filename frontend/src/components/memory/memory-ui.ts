export const memoryInput =
  "min-h-10 w-full min-w-0 rounded-input border border-border bg-bg px-3 py-2 text-ui-label text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-surface-2 disabled:text-muted";
export const memoryButton =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-input border border-border bg-surface px-4 py-2 text-ui-label text-text transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50";
export const memoryPrimary = memoryButton
  .replace("border-border", "border-transparent")
  .replace("bg-surface", "bg-accent-fill")
  .replace("text-text", "text-accent-fg")
  .replace("hover:bg-surface-hover", "hover:bg-accent-fill/90");
export type MemoryCategory = { id: string; name: string };
