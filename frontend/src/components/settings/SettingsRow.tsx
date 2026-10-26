import type { ReactNode } from "react";
import { cn } from "../../lib/ui";

/** The same label/control layout used by General and Progress settings. */
export function SettingsRow({
  label,
  description,
  children,
  inline = false,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-14 gap-x-4 gap-y-2 py-2",
        inline
          ? "items-center justify-between"
          : "flex-col sm:flex-row sm:items-center sm:justify-between",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-ui-label font-medium text-text">{label}</div>
        {description && (
          <p className="mt-1 text-ui-caption leading-relaxed text-muted">
            {description}
          </p>
        )}
      </div>
      <div
        className={cn(
          "flex min-w-0 shrink-0 items-center justify-end",
          inline ? "self-center" : "w-full sm:w-auto sm:max-w-[55%]",
        )}
      >
        {children}
      </div>
    </div>
  );
}
