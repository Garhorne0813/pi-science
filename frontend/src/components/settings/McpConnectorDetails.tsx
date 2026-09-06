import { RefreshCw, Trash2 } from "lucide-react";
import type { McpConnector, McpToolSummary } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";

export function McpConnectorDetails({ connector, tools, workspaceCwd, onRefresh, onDelete, onSetDecision }: {
  connector: McpConnector;
  tools: McpToolSummary[];
  workspaceCwd: string | null;
  onRefresh: () => void;
  onDelete: () => void;
  onSetDecision: (tool: McpToolSummary, decision: "inherit" | "allow" | "ask" | "deny") => void;
}) {
  const { t } = useTranslation();
  const location = connector.endpoint_url || [connector.command, ...connector.args].filter(Boolean).join(" ") || connector.socket_path;

  return <tr id={`mcp-connector-details-${connector.connector_id}`}>
    <td colSpan={4} className="bg-surface-2/20 px-3 pb-3 pt-0">
      <div className="rounded-input border border-border bg-surface px-4 py-3 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold text-text">{connector.display_name}</h3>
            {connector.source === "builtin"
              ? <p className="mt-1 text-xs text-muted">{t("settings.mcpPage.builtinHint")}</p>
              : <p className="mt-1 truncate font-mono text-xs text-muted" title={location || undefined}>{location}</p>}
          </div>
          {connector.source !== "builtin" && <button type="button" aria-label={t("settings.mcpPage.delete", { name: connector.display_name })} onClick={onDelete} className="shrink-0 text-error-text"><Trash2 size={16} /></button>}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <div>
            <h4 className="text-xs font-semibold text-text">{t("settings.mcpPage.toolPermissions")}</h4>
            {workspaceCwd && <p className="mt-1 text-[10px] text-muted">{t("settings.mcpPage.projectOverrideHint")}</p>}
          </div>
          <button type="button" aria-label={t("settings.mcpPage.refreshTools")} onClick={onRefresh} className="text-muted"><RefreshCw size={14} /></button>
        </div>
        <div className="mt-2 divide-y divide-border">{tools.length ? tools.map((tool) => <div key={tool.name} className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0"><p className="text-xs text-text">{tool.title || tool.name}</p><p className="line-clamp-1 text-[10px] text-muted">{tool.description}</p></div>
          <select aria-label={t("settings.mcpPage.permissionFor", { name: tool.name })} value={workspaceCwd ? tool.decision_scope === "project" ? tool.decision : "inherit" : tool.decision} onChange={(event) => onSetDecision(tool, event.target.value as "inherit" | "allow" | "ask" | "deny")} className="shrink-0 rounded-input border border-border bg-surface px-2 py-1 text-xs text-text">
            {workspaceCwd && <option value="inherit">{t("settings.mcpPage.permissionInherit")}</option>}
            <option value="allow">{t("settings.mcpPage.permissionAllow")}</option>
            <option value="ask">{t("settings.mcpPage.permissionAsk")}</option>
            <option value="deny">{t("settings.mcpPage.permissionDeny")}</option>
          </select>
        </div>) : <p className="py-3 text-xs text-muted">{t("settings.mcpPage.noToolMetadata")}</p>}</div>
      </div>
    </td>
  </tr>;
}
