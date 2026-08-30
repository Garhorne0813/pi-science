import { AlertTriangle, Loader2, Server, ShieldCheck } from "lucide-react";
import type { McpConnector } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";

export function McpRow({ connector, busy, selected, onSelect, onToggle, onProbe }: {
  connector: McpConnector;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onProbe: () => void;
}) {
  const { t } = useTranslation();
  const ready = connector.runtime_state === "ready" || connector.runtime_state === "connected";
  const description = connector.source === "builtin" && connector.name === "paper-search"
    ? t("settings.mcpPage.paperSearchDescription")
    : connector.description || "—";
  return <tr className={cn("align-top hover:bg-surface-2/30", selected && "bg-surface-2/50")}>
    <td className="px-4 py-3"><button type="button" onClick={onSelect} className="flex min-w-0 items-start gap-2 text-left"><Server size={16} className="mt-0.5 shrink-0 text-muted" /><span className="min-w-0"><span className="flex items-center gap-1.5"><span className="block truncate text-sm font-medium text-text">{connector.display_name}</span>{connector.source === "builtin" && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">{t("settings.mcpPage.builtin")}</span>}</span><span className="text-[10px] text-muted">{connector.name}</span></span></button></td>
    <td className="hidden px-4 py-3 text-xs text-muted md:table-cell">{description}</td>
    <td className="px-4 py-3"><span className={cn("inline-flex items-center gap-1.5 text-xs", ready ? "text-ok-text" : connector.runtime_state === "error" ? "text-error-text" : "text-muted")}>{ready ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}{t(`settings.mcpPage.runtimeState.${connector.runtime_state}`)}</span><p className="mt-1 text-[10px] text-muted">{t(`settings.mcpPage.authState.${connector.auth_state}`)} · {t(`settings.mcpPage.transport.${connector.transport}`)}</p></td>
    <td className="hidden px-4 py-3 text-xs text-muted md:table-cell">{t("settings.mcpPage.toolCount", { count: connector.tool_count })}</td>
    <td className="px-4 py-3"><button type="button" disabled={busy} onClick={onProbe} className="text-xs text-link hover:underline">{t("settings.mcpPage.test")}</button></td>
    <td className="px-4 py-3 text-center"><span className="inline-flex items-center gap-2">{busy && <Loader2 size={12} className="animate-spin text-muted" />}<input type="checkbox" aria-label={t("settings.mcpPage.enable", { name: connector.display_name })} checked={connector.binding?.enabled === true} disabled={busy} onChange={(event) => onToggle(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" /></span></td>
  </tr>;
}
