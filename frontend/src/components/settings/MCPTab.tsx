import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { queryClient } from "../../lib/client/query-client";
import { mcpCatalogQuery, settingsApi } from "../../lib/settings";
import type { McpServer } from "../../lib/settings";
import { McpRow } from "./McpRow";

export function MCPTab({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  // The toggle updates this list optimistically and rolls back on failure, so the
  // catalog is held locally and read through the shared cache rather than by useQuery.
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceCwd) {
      setLoading(false);
      setServers([]);
      setError(null);
      return;
    }
    setLoading(true);
    queryClient.fetchQuery(mcpCatalogQuery(workspaceCwd, t("settings.mcpPage.loadError")))
      .then((data) => setServers(data.servers || []))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, [t, workspaceCwd]);

  const toggle = async (id: string, on: boolean) => {
    const previous = servers.find((server) => server.id === id)?.enabled || false;
    setSaving(id);
    setError(null);
    setServers((prev) => prev.map((server) => (server.id === id ? { ...server, enabled: on } : server)));
    try {
      // The interpolated fallback is only reached when the response carries neither
      // `error` nor `detail`, which this route never produces.
      await settingsApi.setMcpEnabled(id, on, t("settings.mcpPage.updateError", { error: "" }));
    } catch (cause) {
      setServers((prev) => prev.map((server) => (server.id === id ? { ...server, enabled: previous } : server)));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  };

  if (loading)
    return (
      <div className="flex min-h-[240px] items-center justify-center text-sm text-muted">
        <Loader2 size={18} className="mr-2 animate-spin" />
        {t("common.loading")}
      </div>
    );

  return (
    <div className="space-y-card pt-card">
      <div className="max-w-2xl">
        <p className="text-ui-body text-muted">{t("settings.mcpPage.description")}</p>
        <p className="mt-1 text-ui-caption text-muted">{t("settings.mcpPage.selectionHint")}</p>
      </div>
      {error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-caption text-error-text">{error}</p>}
      {!workspaceCwd ? (
        <p className="rounded-input border border-dashed border-border p-panel text-ui-caption text-muted">{t("settings.mcpPage.workspaceRequired")}</p>
      ) : (
        <section aria-labelledby="mcp-servers-heading" className="space-y-2">
          <div className="flex items-center justify-between gap-3 px-1">
            <h2 id="mcp-servers-heading" className="text-ui-label font-semibold text-text">{t("settings.mcpPage.servers")}</h2>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{servers.length}</span>
          </div>
          <div className="ui-card-flat overflow-hidden rounded-card">
            <div>
              <table className="w-full table-fixed text-left">
                <colgroup>
                  <col className="w-[30%] md:w-[23%]" />
                  <col className="hidden w-[31%] md:table-column" />
                  <col className="w-[52%] md:w-[25%]" />
                  <col className="hidden w-[13%] md:table-column" />
                  <col className="w-[18%] md:w-[8%]" />
                </colgroup>
                <thead className="border-b border-border bg-surface-2/50">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 text-ui-caption font-medium text-muted">{t("settings.mcpPage.tableName")}</th>
                    <th scope="col" className="hidden px-4 py-2.5 text-ui-caption font-medium text-muted md:table-cell">{t("settings.mcpPage.tableDescription")}</th>
                    <th scope="col" className="px-4 py-2.5 text-ui-caption font-medium text-muted">{t("settings.mcpPage.tableStatus")}</th>
                    <th scope="col" className="hidden px-4 py-2.5 text-ui-caption font-medium text-muted md:table-cell">{t("settings.mcpPage.tableTools")}</th>
                    <th scope="col" className="w-16 px-4 py-2.5 text-center text-ui-caption font-medium text-muted">{t("settings.mcpPage.tableEnabled")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {servers.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">{t("settings.mcpPage.empty")}</td></tr>
                  ) : servers.map((server) => (
                    <McpRow key={server.id} server={server} saving={saving === server.id} disabled={saving !== null} onToggle={(id, enabled) => void toggle(id, enabled)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
