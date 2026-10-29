import { buttonClass, inputClass } from "../ui/controls";
export const memoryInput = inputClass + " w-full";
export const memoryButton = buttonClass;
export const memoryPrimary = memoryButton
  .replace("border-border", "border-transparent")
  .replace("bg-surface", "bg-accent-fill")
  .replace("text-text", "text-accent-fg")
  .replace("hover:bg-surface-hover", "hover:bg-accent-fill/90");
export type MemoryCategory = { id: string; name: string };
