import { Loader2 } from "lucide-react";

export function LoopActionButton({ busy, onClick, icon, label }: { busy: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button type="button" disabled={busy} onClick={onClick} className="flex min-h-11 items-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:text-text disabled:opacity-50">
      {busy ? <Loader2 size={14} className="animate-spin" /> : icon} {label}
    </button>
  );
}
