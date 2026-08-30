import { AlertTriangle, Loader2, Server, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import type { McpServer } from "../../lib/settings";

export function McpRow({
  server,
  saving,
  disabled,
  onToggle,
}: {
  server: McpServer;
  saving: boolean;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  const { t } = useTranslation();
  const ready = server.health === "ready";
  const health = server.health || t("settings.mcpPage.unknown");

  return (
    <tr className="align-top hover:bg-surface-2/30">
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <Server size={16} className="mt-0.5 shrink-0 text-muted" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
              <span className="truncate">{server.name}</span>
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{server.transport}</span>
            </div>
            {server.id !== server.name && <p className="mt-1 truncate text-[10px] text-muted">{server.id}</p>}
          </div>
        </div>
      </td>
      <td className="hidden px-4 py-3 text-xs text-muted md:table-cell">
        <p className="line-clamp-2">{server.description || server.id}</p>
        {(server.terms_url || server.privacy_url) && (
          <div className="mt-1.5 flex gap-2 text-[10px]">
            {server.terms_url && <a href={server.terms_url} target="_blank" rel="noreferrer" className="text-link hover:underline">{t("settings.mcpPage.terms")}</a>}
            {server.privacy_url && <a href={server.privacy_url} target="_blank" rel="noreferrer" className="text-link hover:underline">{t("settings.mcpPage.privacy")}</a>}
          </div>
        )}
      </td>
      <td className="min-w-0 px-4 py-3">
        <span className={cn("inline-flex items-center gap-1.5 text-xs", ready ? "text-ok-text" : server.health === "error" ? "text-error-text" : "text-muted")}>
          {ready ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
          {health}
        </span>
        <div className="mt-1.5 space-y-0.5 text-[10px]">
          <p className={server.auth === "missing" ? "text-warn-text" : "text-muted"}>{t("settings.mcpPage.auth")}: {server.auth}</p>
          <p className={server.data_egress === "remote" ? "text-warn-text" : "text-muted"}>{t("settings.mcpPage.data")}: {server.data_egress}</p>
        </div>
        {server.error && <p className="mt-1 break-words text-[10px] text-error-text">{server.error}</p>}
      </td>
      <td className="hidden whitespace-nowrap px-4 py-3 text-xs text-muted md:table-cell">{t("settings.mcpPage.toolCount", { count: server.tools.length })}</td>
      <td className="px-4 py-3 text-center">
        <div className="flex items-center justify-center gap-2">
          {saving && <Loader2 size={12} className="shrink-0 animate-spin text-muted" />}
          <input
            type="checkbox"
            aria-label={t("settings.mcpPage.enable", { name: server.name })}
            checked={server.enabled}
            disabled={disabled}
            onChange={(event) => onToggle(server.id, event.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
        </div>
      </td>
    </tr>
  );
}
