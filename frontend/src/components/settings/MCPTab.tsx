import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { queryClient } from "../../lib/query-client";
import { mcpCatalogQuery, settingsApi } from "../../lib/settings-api";
import type { McpServer } from "../../lib/settings-types";
import { McpRow } from "./McpRow";
import { Section } from "./Section";

export function MCPTab({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  // The toggle updates this list optimistically and rolls back on failure, so the
  // catalog is held locally and read through the shared cache rather than by useQuery.
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    setServers((prev) => prev.map((server) => (server.id === id ? { ...server, enabled: on } : server)));
    try {
      // The interpolated fallback is only reached when the response carries neither
      // `error` nor `detail`, which this route never produces.
      await settingsApi.setMcpEnabled(id, on, t("settings.mcpPage.updateError", { error: "" }));
    } catch (cause) {
      setServers((prev) => prev.map((server) => (server.id === id ? { ...server, enabled: previous } : server)));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (loading)
    return (
      <div className="text-sm text-muted py-4">
        <Loader2 size={16} className="animate-spin inline mr-2" />
        {t("common.loading")}
      </div>
    );

  return (
    <div className="space-y-6">
      <Section title={t("settings.mcpPage.title")}>
        {error && <p className="mb-3 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}
        <p className="text-[11px] text-muted mb-3">{t("settings.mcpPage.description")}</p>
        {!workspaceCwd ? (
          <p className="rounded-input border border-dashed border-border px-3 py-3 text-xs text-muted">{t("settings.mcpPage.workspaceRequired")}</p>
        ) : servers.length === 0 ? (
          <p className="text-xs text-muted">{t("settings.mcpPage.empty")}</p>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <McpRow key={server.id} server={server} onToggle={toggle} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
