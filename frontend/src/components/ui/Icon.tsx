import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { cn } from "@/lib/ui";

const ICON_SIZES = { xs: 12, sm: 14, md: 16, lg: 20 } as const;
const BUTTON_SIZES = {
  compact: { button: "h-icon w-icon", icon: "sm" },
  standard: { button: "h-tool w-tool", icon: "md" },
  touch: { button: "h-primary w-primary", icon: "md" },
} as const;

export type IconSize = keyof typeof ICON_SIZES;
export type IconButtonSize = keyof typeof BUTTON_SIZES;

/** Shared Lucide renderer: product icons use one optical size and stroke system. */
export function Icon({ icon: Glyph, size = "md", strokeWidth = 1.75, ...props }: Omit<LucideProps, "size"> & { icon: LucideIcon; size?: IconSize | number }) {
  return <Glyph size={typeof size === "number" ? size : ICON_SIZES[size]} strokeWidth={strokeWidth} aria-hidden="true" {...props} />;
}

/** Accessible icon-only button with a consistent visual box and touch target. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title"> & {
  icon: LucideIcon;
  label: string;
  size?: IconButtonSize;
  iconClassName?: string;
  title?: string;
}>(({ icon, label, size = "standard", className, iconClassName, title, type = "button", ...props }, ref) => {
  const metrics = BUTTON_SIZES[size];
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cn(
        "icon-btn-hit inline-flex shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-35",
        metrics.button,
        className,
      )}
      {...props}
    >
      <Icon icon={icon} size={metrics.icon} className={iconClassName} />
    </button>
  );
});

IconButton.displayName = "IconButton";
