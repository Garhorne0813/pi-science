import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { McpServer } from "../../lib/settings-types";

export function McpRow({ server, onToggle }: { server: McpServer; onToggle: (id: string, on: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text">{server.name}</span>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{server.transport}</span>
          </div>
          <p className="text-[11px] text-muted mt-0.5">{server.description || server.id}</p>
          <div className="flex items-center gap-2 mt-1.5">
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
        <button onClick={() => onToggle(server.id, !server.enabled)} className={cn("shrink-0 rounded-full px-3 py-1 text-[11px] font-medium transition-colors", server.enabled ? "bg-ok text-white" : "bg-surface-2 text-muted hover:bg-surface hover:text-text")}>
          {server.enabled ? t("settings.actions.on") : t("settings.actions.off")}
        </button>
      </div>
    </div>
  );
}
