import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { MemorySettings } from "@pi-science/contracts";
import { memoryRequest, useMemorySettings } from "../../lib/memory";
import { modelSelectionApi } from "../../lib/model-selection";
import { clearMemorySettingsDraft, MemorySettingsForm } from "./MemorySettingsForm";

/** Memory policy is owner-wide, including when Settings opened inside a project. */
export function MemoryTab() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const settings = useMemorySettings();
  const catalog = useQuery({
    ...modelSelectionApi.catalogQuery(null),
    enabled: !!settings.data,
    staleTime: 30000,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const onDirtyChange = useCallback((dirty: boolean) => { if (dirty) setSaved(false); }, []);
  async function save(value: Omit<MemorySettings, "revision">) {
    if (!settings.data) return false;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await memoryRequest(null, "/settings", "PATCH", {
        expectedRevision: settings.data.revision,
        settings: value,
      });
      clearMemorySettingsDraft();
      await client.invalidateQueries({ queryKey: ["memory"] });
      setSaved(true);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }
  const failure = error || (settings.error ? String(settings.error) : "");
  return (
    <div className="space-y-4">
      <p className="text-ui-caption leading-relaxed text-muted">
        {t("memory.settingsDescription")}
      </p>
      {settings.isPending && <p role="status">{t("common.loading")}</p>}
      {failure && (
        <p role="alert" className="text-error-text">
          {failure}
          <button
            className="ml-2 text-link"
            onClick={() => {
              setError("");
              void settings.refetch();
            }}
          >
            {t("common.refresh")}
          </button>
        </p>
      )}
      {saved && <p role="status">{t("memory.saved")}</p>}
      {catalog.error && (
        <p role="alert" className="text-ui-caption text-error-text">
          {t("memory.catalogError")}
          <button
            type="button"
            className="ml-2 text-link"
            onClick={() => void catalog.refetch()}
          >
            {t("common.refresh")}
          </button>
        </p>
      )}
      {settings.data && (
        <MemorySettingsForm
          key={settings.data.revision}
          value={settings.data}
          models={(catalog.data?.available_models ?? []).map((m) => ({
            value: m.id,
            label: m.label || m.id,
          }))}
          onDirtyChange={onDirtyChange}
          busy={saving}
          save={save}
        />
      )}
    </div>
  );
}
