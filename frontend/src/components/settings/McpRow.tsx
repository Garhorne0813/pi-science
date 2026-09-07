import { AlertTriangle, ChevronRight, Loader2, Server, ShieldCheck } from "lucide-react";
import type { McpConnector } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";

export function McpRow({ connector, busy, selected, actionsEnabled, onSelect, onToggle, onProbe }: {
  connector: McpConnector;
  busy: boolean;
  selected: boolean;
  actionsEnabled: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onProbe: () => void;
}) {
  const { t } = useTranslation();
  const ready = connector.runtime_state === "ready" || connector.runtime_state === "connected";
  const description = connector.source === "builtin" && connector.name === "paper-search"
    ? t("settings.mcpPage.paperSearchDescription")
    : connector.description || "—";
  const detailId = `mcp-connector-details-${connector.connector_id}`;
  return <tr className={cn("align-top hover:bg-surface-2/30", selected && "bg-surface-2/50")}>
    <td className="overflow-hidden px-4 py-3"><button type="button" aria-expanded={selected} aria-controls={detailId} aria-label={t(selected ? "settings.mcpPage.hideDetails" : "settings.mcpPage.showDetails", { name: connector.display_name })} onClick={onSelect} className="flex w-full min-w-0 max-w-full items-start gap-2 overflow-hidden text-left"><ChevronRight size={14} className={cn("mt-0.5 shrink-0 text-muted transition-transform", selected && "rotate-90")} /><Server size={16} className="mt-0.5 shrink-0 text-muted" /><span className="min-w-0 flex-1 overflow-hidden"><span className="flex min-w-0 items-center gap-1.5"><span className="block min-w-0 flex-1 truncate text-sm font-medium text-text" title={connector.display_name}>{connector.display_name}</span>{connector.source === "builtin" && <span className="shrink-0 whitespace-nowrap rounded bg-surface-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">{t("settings.mcpPage.builtin")}</span>}</span><span className="block truncate text-[10px] text-muted" title={connector.name}>{connector.name}</span></span></button></td>
    <td className="hidden overflow-hidden px-4 py-3 text-xs text-muted md:table-cell"><p className="line-clamp-2 break-words" title={description}>{description}</p></td>
    <td className="px-4 py-3"><span className={cn("inline-flex items-center gap-1.5 text-xs", ready ? "text-ok-text" : connector.runtime_state === "error" ? "text-error-text" : "text-muted")}>{ready ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}{t(`settings.mcpPage.runtimeState.${connector.runtime_state}`)}</span><p className="mt-1 text-[10px] text-muted">{t(`settings.mcpPage.authState.${connector.auth_state}`)} · {t(`settings.mcpPage.transport.${connector.transport}`)} · {t("settings.mcpPage.toolCount", { count: connector.tool_count })}</p></td>
    <td className="px-4 py-3"><span className="inline-flex items-center gap-3"><button type="button" disabled={busy || !actionsEnabled} onClick={onProbe} className="text-xs text-link hover:underline disabled:text-muted disabled:no-underline">{t("settings.mcpPage.test")}</button>{busy && <Loader2 size={12} className="animate-spin text-muted" />}<input type="checkbox" aria-label={t("settings.mcpPage.enable", { name: connector.display_name })} checked={connector.settings.enabled} disabled={busy || !actionsEnabled} onChange={(event) => onToggle(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" /></span></td>
  </tr>;
}
