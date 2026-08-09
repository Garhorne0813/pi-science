import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import type { McpServer } from "../../lib/settings";

export function McpRow({ server, onToggle }: { server: McpServer; onToggle: (id: string, on: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-14 items-start justify-between gap-panel border-b border-faint py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-ui-label font-medium text-text">{server.name}</span>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{server.transport}</span>
          </div>
          <p className="mt-0.5 text-ui-caption text-muted">{server.description || server.id}</p>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn("text-[10px]", server.health === "ready" ? "text-ok" : server.health === "error" ? "text-error" : "text-muted")}>
              {t("settings.mcpPage.health")}: {server.health}
            </span>
            <span className={cn("text-[10px]", server.auth === "missing" ? "text-warn" : "text-muted")}>
              {t("settings.mcpPage.auth")}: {server.auth}
            </span>
            <span className={cn("text-[10px]", server.data_egress === "remote" ? "text-warn" : "text-muted")}>
              {t("settings.mcpPage.data")}: {server.data_egress}
            </span>
            <span className="text-[10px] text-muted">{t("settings.mcpPage.toolCount", { count: server.tools.length })}</span>
          </div>
          {server.error && <p className="mt-1 text-[10px] text-error">{server.error}</p>}
          {(server.terms_url || server.privacy_url) && (
            <div className="mt-1 flex gap-2 text-[10px]">
              {server.terms_url && (
                <a href={server.terms_url} target="_blank" className="text-link hover:underline">
                  {t("settings.mcpPage.terms")}
                </a>
              )}
              {server.privacy_url && (
                <a href={server.privacy_url} target="_blank" className="text-link hover:underline">
                  {t("settings.mcpPage.privacy")}
                </a>
              )}
            </div>
          )}
        </div>
        <button onClick={() => onToggle(server.id, !server.enabled)} className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors", server.enabled ? "bg-ok text-white" : "bg-surface-2 text-muted hover:bg-surface hover:text-text")}>
          {server.enabled ? t("settings.actions.on") : t("settings.actions.off")}
        </button>
      </div>
    </div>
  );
}
