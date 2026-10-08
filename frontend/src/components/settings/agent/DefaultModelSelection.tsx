import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ModelSelection } from "@pi-science/contracts";
import type { SettingsConfig } from "../../../lib/settings";
import { modelSelectionApi, modelSelectionKeys } from "../../../lib/model-selection";
import { queryClient } from "../../../lib/client/query-client";
import { clampThinkingLevel } from "../../../lib/client/pi-science-client";
import { SettingsSelectMenu } from "../SettingsSelectMenu";

export function DefaultModelSelection({ models, saving, onSave }: { models: SettingsConfig["available_models"]; saving: boolean; onSave: (selection: ModelSelection) => Promise<void> }) {
  const { t } = useTranslation();
  const defaults = useQuery({ queryKey: modelSelectionKeys.default, queryFn: ({ signal }) => modelSelectionApi.readDefault({ signal }), staleTime: 0 }, queryClient);
  const [draft, setDraft] = useState<ModelSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = defaults.data?.selection;
  const selected = draft ?? base;
  const model = models.find((item) => item.id === selected?.model);
  const levels = model?.thinking_levels?.length ? model.thinking_levels : ["off"];
  const dirty = Boolean(draft && (draft.model !== base?.model || draft.thinking !== base?.thinking));
  const save = async () => {
    if (!draft) return;
    setError(null);
    try { await onSave(draft); setDraft(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="mt-4 space-y-3 border-t border-border pt-4">
    {defaults.error && <p role="alert" className="text-ui-caption text-error-text">{defaults.error.message}<button type="button" onClick={() => void defaults.refetch()} className="ml-2 min-h-9 px-2 text-link">{t("settings.redesign.retryLoad")}</button></p>}
    <label className="block text-ui-caption text-muted">{t("settings.model.defaultLabel")}</label>
    <SettingsSelectMenu ariaLabel={t("settings.model.defaultLabel")} variant="field" value={selected?.model ?? ""} options={models.map((item) => ({ value: item.id, label: item.label || item.id }))} disabled={!base || saving || models.length === 0} placeholder={selected?.model || t("settings.model.select")} searchable maxVisibleOptions={50} moreResultsLabel={t("settings.selection.refineSearch")} searchPlaceholder={t("settings.model.searchPlaceholder")} emptyMessage={t("settings.model.searchEmpty")} onSelect={(id) => {
      const next = models.find((item) => item.id === id);
      setDraft({ model: id, thinking: clampThinkingLevel(selected?.thinking ?? "off", next?.thinking_levels ?? ["off"]) as ModelSelection["thinking"] });
    }} />
    <label className="block text-ui-caption text-muted">{t("settings.model.thinking")}</label>
    <SettingsSelectMenu ariaLabel={t("settings.model.thinking")} variant="field" value={selected?.thinking ?? "off"} options={levels.map((level) => ({ value: level, label: t(`settings.thinking.${level}`, { defaultValue: level }) }))} disabled={!model || saving} onSelect={(thinking) => setDraft({ model: selected?.model ?? null, thinking: thinking as ModelSelection["thinking"] })} />
    {error && <p role="alert" className="text-ui-caption text-error-text">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button type="button" disabled={!base || saving || !selected?.model} onClick={() => setDraft({ model: null, thinking: "off" })} className="min-h-9 rounded-input px-3 text-ui-caption text-muted hover:bg-surface-hover disabled:opacity-40">{t("settings.selection.clearDefault")}</button>
      <button type="button" disabled={!dirty || saving || !base} onClick={() => void save()} className="min-h-9 rounded-input bg-accent px-4 text-ui-caption text-white disabled:opacity-40">{saving ? t("common.saving") : t("common.save")}</button>
    </div>
  </div>;
}
