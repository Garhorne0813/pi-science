import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { queryClient } from "../../lib/client/query-client";
import { mcpCatalogQuery, settingsApi } from "../../lib/settings";
import type { McpServer } from "../../lib/settings";
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
      <div className="py-card text-ui-body text-muted">
        <Loader2 size={16} className="animate-spin inline mr-2" />
        {t("common.loading")}
      </div>
    );

  return (
    <div className="space-y-card">
      <Section>
        {error && <p className="mb-panel rounded-input bg-error/10 px-panel py-2 text-ui-caption text-error">{error}</p>}
        {!workspaceCwd ? (
          <p className="rounded-input border border-dashed border-border p-panel text-ui-caption text-muted">{t("settings.mcpPage.workspaceRequired")}</p>
        ) : servers.length === 0 ? (
          <p className="text-ui-caption text-muted">{t("settings.mcpPage.empty")}</p>
        ) : (
          <div>
            {servers.map((server) => (
              <McpRow key={server.id} server={server} onToggle={toggle} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
