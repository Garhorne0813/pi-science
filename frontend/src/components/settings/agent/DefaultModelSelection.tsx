import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRight, BrainCircuit, Image, Wrench } from "lucide-react";
import type { ModelSelection } from "@pi-science/contracts";
import { modelSelectionApi, modelSelectionKeys } from "../../../lib/model-selection";
import { queryClient } from "../../../lib/client/query-client";
import { clampThinkingLevel } from "../../../lib/client/pi-science-client";
import { SettingsSelectMenu } from "../SettingsSelectMenu";

export function DefaultModelSelection({ scope = null, onCommitted, onOpenModels }: { scope?: string | null; onCommitted?: () => Promise<void>; onOpenModels?: () => void }) {
  const { t } = useTranslation();
  const defaults = useQuery({ queryKey: modelSelectionKeys.default, queryFn: ({ signal }) => modelSelectionApi.readDefault({ signal }), staleTime: 0 }, queryClient);
  const catalog = useQuery(modelSelectionApi.catalogQuery(scope), queryClient);
  const index = useMemo(() => {
    const models = catalog.data?.available_models ?? [];
    return { byId: new Map(models.map((model) => [model.id, model])), options: models.map((model) => ({ value: model.id, label: model.label || model.id })) };
  }, [catalog.data]);
  const [draft, setDraft] = useState<ModelSelection | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const refreshVersion = useRef(0);
  const base = defaults.data?.selection;
  const selected = draft ?? base;
  const model = selected?.model ? index.byId.get(selected.model) : undefined;
  const configured = base?.model ? index.byId.get(base.model) : undefined;
  const levels = model?.thinking_levels?.length ? model.thinking_levels : ["off"];
  const dirty = Boolean(draft && (draft.model !== base?.model || draft.thinking !== base?.thinking));
  const edit = (selection: ModelSelection) => { setDraft(selection); setSaved(false); };
  const refresh = async () => {
    const version = ++refreshVersion.current;
    setSyncWarning(null);
    try { await onCommitted?.(); }
    catch (cause) { if (version === refreshVersion.current) setSyncWarning(cause instanceof Error ? cause.message : String(cause)); }
  };
  const save = async () => {
    if (!draft || saving) return;
    setSaving(true); setError(null); setSyncWarning(null);
    try {
      await modelSelectionApi.saveDefault(draft, scope);
      setDraft(null); setSaved(true);
      // The PUT acknowledgement commits the selection. Context refresh is a
      // separate best-effort operation and cannot turn success into failure.
      void refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const loadError = defaults.error ?? catalog.error;
  const contextWindow = configured?.context_window;
  return <section aria-labelledby="agent-model-title" className="rounded-card border border-border bg-sidebar p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id="agent-model-title" className="text-ui-body font-medium text-text">{t("settings.agent.activeModelTitle")}</h3>
      {onOpenModels && <button type="button" onClick={onOpenModels} className="flex min-h-9 items-center gap-2 rounded-input px-2 text-ui-caption text-link hover:bg-surface-hover">{t("settings.redesign.manageModels")}<ArrowRight size={14} /></button>}
    </div>
    <p className="mt-3 break-words text-ui-title font-medium text-text">{configured?.label || base?.model || t("settings.agent.noModel")}</p>
    <p className="mt-1 text-ui-caption text-muted">{t("settings.redesign.modelSelectionHelp")}</p>
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      {loadError && <p role="alert" className="text-ui-caption text-error-text">{loadError.message}<button type="button" onClick={() => void (defaults.error ? defaults.refetch() : catalog.refetch())} className="ml-2 min-h-9 px-2 text-link">{t("settings.redesign.retryLoad")}</button></p>}
      {catalog.data && base?.model && !configured && <p role="alert" className="text-ui-caption text-error-text">{t("settings.redesign.modelUnavailable")}</p>}
      <label className="block text-ui-caption text-muted">{t("settings.model.defaultLabel")}</label>
      <SettingsSelectMenu ariaLabel={t("settings.model.defaultLabel")} variant="field" value={selected?.model ?? ""} options={index.options} disabled={!base || saving || index.options.length === 0} placeholder={selected?.model || t("settings.model.select")} searchable maxVisibleOptions={50} moreResultsLabel={t("settings.selection.refineSearch")} searchPlaceholder={t("settings.model.searchPlaceholder")} emptyMessage={t("settings.model.searchEmpty")} onSelect={(id) => {
        const next = index.byId.get(id);
        edit({ model: id, thinking: clampThinkingLevel(selected?.thinking ?? "off", next?.thinking_levels ?? ["off"]) as ModelSelection["thinking"] });
      }} />
      <label className="block text-ui-caption text-muted">{t("settings.model.thinking")}</label>
      <SettingsSelectMenu ariaLabel={t("settings.model.thinking")} variant="field" value={selected?.thinking ?? "off"} options={levels.map((level) => ({ value: level, label: t(`settings.thinking.${level}`, { defaultValue: level }) }))} disabled={!model || saving} onSelect={(thinking) => edit({ model: selected?.model ?? null, thinking: thinking as ModelSelection["thinking"] })} />
      {error && <p role="alert" className="text-ui-caption text-error-text">{error}</p>}
      {saved && !syncWarning && <p role="status" className="text-ui-caption text-muted">{t("settings.selection.saved")}</p>}
      {syncWarning && <p role="status" className="text-ui-caption text-muted">{t("settings.selection.syncWarning", { error: syncWarning })}<button type="button" onClick={() => void refresh()} className="ml-2 min-h-9 px-2 text-link">{t("settings.redesign.retryLoad")}</button></p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" disabled={!base || saving || !selected?.model} onClick={() => edit({ model: null, thinking: "off" })} className="min-h-9 rounded-input px-3 text-ui-caption text-muted hover:bg-surface-hover disabled:opacity-40">{t("settings.selection.clearDefault")}</button>
        <button type="button" disabled={!dirty || saving || !base} onClick={() => void save()} className="min-h-9 rounded-input bg-accent px-4 text-ui-caption text-white disabled:opacity-40">{saving ? t("common.saving") : t("common.save")}</button>
      </div>
    </div>
    <dl className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
      <div><dt className="text-ui-caption text-muted">{t("settings.redesign.contextWindow")}</dt><dd className="mt-1 font-mono text-ui-body text-text">{contextWindow && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? t("settings.redesign.tokens", { count: contextWindow }) : t("settings.redesign.unknown")}</dd></div>
      <div><dt className="text-ui-caption text-muted">{t("settings.redesign.thinking")}</dt><dd className="mt-1 text-ui-body text-text">{base && configured?.thinking_levels?.includes(base.thinking) ? t(`settings.thinking.${base.thinking}`, { defaultValue: base.thinking }) : t("settings.redesign.unknown")}</dd></div>
    </dl>
    {configured && <div className="mt-4 flex flex-wrap gap-2">
      {configured.reasoning && <span className="flex items-center gap-1 rounded-input bg-surface-2 px-2 py-1 text-ui-caption text-muted"><BrainCircuit size={14} />{t("settings.redesign.reasoning")}</span>}
      {configured.vision && <span className="flex items-center gap-1 rounded-input bg-surface-2 px-2 py-1 text-ui-caption text-muted"><Image size={14} />{t("settings.redesign.images")}</span>}
      {configured.tools && <span className="flex items-center gap-1 rounded-input bg-surface-2 px-2 py-1 text-ui-caption text-muted"><Wrench size={14} />{t("settings.redesign.tools")}</span>}
    </div>}
  </section>;
}
