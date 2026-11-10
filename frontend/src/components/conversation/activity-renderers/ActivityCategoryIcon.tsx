import { BookOpen, Bot, FileText, FolderOpen, Globe, Pencil, Search, Sigma, Sparkles, Terminal, Wrench, type LucideIcon } from "lucide-react";
import type { ActivityCategory } from "@pi-science/contracts";
import { toolActivityCategory } from "../../../lib/conversation/activity-presenters";
import type { ToolCallBlock } from "../../../types/thread";
import { cn } from "../../../lib/ui";

export const ACTIVITY_CATEGORY_ICONS: Record<ActivityCategory, LucideIcon> = {
  read: FileText, search: Search, browse: FolderOpen, edit: Pencil, execute: Terminal, compute: Sigma, web: Globe, literature: BookOpen, generate: Sparkles, delegate: Bot, other: Wrench,
};

export function ActivityCategoryIcon({ block, size = 14, className }: { block: ToolCallBlock; size?: number; className?: string }) {
  const category = toolActivityCategory(block);
  const Icon = ACTIVITY_CATEGORY_ICONS[category];
  return <span data-activity-category={category} className={cn("flex shrink-0 items-center justify-center", className)}><Icon size={size} aria-hidden /></span>;
}
