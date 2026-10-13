import type { HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/ui";

/** Shared chrome only: each viewer owns its scientific controls and canvas. */
export function ViewerToolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { t } = useTranslation();
  return <div role="group" aria-label={t("filePreview.viewerToolbar")} className={cn("preview-toolbar", className)} {...props} />;
}

export function ViewerStatusBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("preview-status", className)} {...props} />;
}
