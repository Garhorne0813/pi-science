import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/ui";
export const inputClass = "min-h-control min-w-0 rounded-input border border-border bg-bg px-3 py-2 text-ui-label text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50";
export const buttonClass = "inline-flex min-h-control items-center justify-center gap-2 rounded-input border border-border bg-surface px-3 py-2 text-ui-label text-text transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50";
export function Button({ primary, className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type={type} className={cn(buttonClass, primary && "border-transparent bg-accent-fill text-accent-fg hover:bg-accent-fill/90", className)} {...props} />;
}
export function ErrorState({ children, retry, retryLabel, busy }: { children: ReactNode; retry: () => void; retryLabel: string; busy?: boolean }) {
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-error/30 bg-error/5 p-card text-ui-body text-error-text"><div className="min-w-0 break-words">{children}</div><Button onClick={retry} disabled={busy}>{retryLabel}</Button></div>;
}
export function EmptyState({ children }: { children: ReactNode }) { return <p role="status" className="py-card text-ui-body text-muted">{children}</p>; }
