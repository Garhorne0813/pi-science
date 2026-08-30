import { useEffect, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProgressAppearance } from "@pi-science/contracts";
import { defaultProgressAppearance } from "@pi-science/contracts";
import { ProgressVisual } from "../progress/ProgressVisual";
import { setProgressAppearance } from "../progress/progress-settings-store";
import { patternsForSlot, type ProgressSlot } from "../progress/ProgressPatternCatalog";
import type { SettingsConfig } from "../../lib/settings";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

const PRESET_PATTERNS: Record<Exclude<ProgressAppearance["preset"], "custom">, ProgressAppearance["patterns"]> = {
  quiet: { thinking: "static-check", currentActivity: "inline-signal", streamingAnswer: "text-decode", imageGeneration: "image-scan", waiting: "static-check", completed: "static-check" },
  research: { thinking: "text-skeleton", currentActivity: "inline-signal", streamingAnswer: "text-decode", imageGeneration: "image-scan", waiting: "static-check", completed: "static-check" },
  science: { thinking: "text-skeleton", currentActivity: "inline-signal", streamingAnswer: "text-cascade", imageGeneration: "image-tiles", waiting: "static-check", completed: "static-check" },
};

const PROGRESS_SELECT_CLASS = "max-w-none border-transparent focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:border-transparent";

const SLOTS: Array<{ id: ProgressSlot; labelKey: string; sample: string }> = [
  { id: "thinking", labelKey: "settings.progress.slot.thinking", sample: "Thinking" },
  { id: "currentActivity", labelKey: "settings.progress.slot.activity", sample: "Reviewing related content" },
  { id: "streamingAnswer", labelKey: "settings.progress.slot.streaming", sample: "AI" },
  { id: "waiting", labelKey: "settings.progress.slot.waiting", sample: "Needs your input" },
];

function configFrom(input: ProgressAppearance | undefined): ProgressAppearance {
  return input ? structuredClone(input) : structuredClone(defaultProgressAppearance);
}

export function ProgressTab({ config, saving, onSave }: { config: SettingsConfig; saving: boolean; onSave: (next: ProgressAppearance) => Promise<void> }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => configFrom(config.progress_appearance));
  useEffect(() => { const next = configFrom(config.progress_appearance); setDraft(next); setProgressAppearance(next); }, [config.progress_appearance]);

  const save = (next: ProgressAppearance) => {
    setDraft(next);
    setProgressAppearance(next);
    void onSave(next);
  };
  const update = (patch: Partial<ProgressAppearance>) => save({ ...draft, ...patch });
  const updatePreset = (preset: ProgressAppearance["preset"]) => save({ ...draft, preset, ...(preset === "custom" ? {} : { patterns: PRESET_PATTERNS[preset] }) });
  const updatePattern = (slot: ProgressSlot, pattern: ProgressAppearance["patterns"][ProgressSlot]) => save({ ...draft, patterns: { ...draft.patterns, [slot]: pattern } });
  const reset = () => save(configFrom(undefined));

  return <div className="space-y-4">
    <section className="overflow-hidden rounded-card border border-faint bg-surface-2/40">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-faint px-4 py-2">
        <div><h2 className="text-[13px] font-semibold text-text">{t("settings.progress.title")}</h2><p className="mt-0.5 text-ui-caption text-muted">{t("settings.progress.description")}</p></div>
        <button type="button" disabled={saving} onClick={reset} className="flex min-h-8 items-center gap-1.5 rounded-input px-2 text-ui-caption text-muted hover:bg-surface-hover hover:text-text"><RotateCcw size={13} />{t("settings.progress.reset")}</button>
      </div>
      <div className="divide-y divide-faint">
        <SettingRow label={t("settings.progress.preset")}><SettingsSelectMenu variant="row" className={PROGRESS_SELECT_CLASS} selectionClassName="bg-surface-selected" ariaLabel={t("settings.progress.preset")} value={draft.preset} options={["quiet", "research", "science", "custom"].map((value) => ({ value, label: t(`settings.progress.preset.${value}`) }))} onSelect={(value) => updatePreset(value as ProgressAppearance["preset"])} /></SettingRow>
        <SettingRow label={t("settings.progress.motion")}><SettingsSelectMenu variant="row" className={PROGRESS_SELECT_CLASS} selectionClassName="bg-surface-selected" ariaLabel={t("settings.progress.motion")} value={draft.motion} options={["system", "full", "off"].map((value) => ({ value, label: t(`settings.progress.motion.${value}`) }))} onSelect={(value) => update({ motion: value as ProgressAppearance["motion"] })} /></SettingRow>
        <SettingRow label={t("settings.progress.color")}><div className="flex items-center gap-2"><SettingsSelectMenu variant="row" className={PROGRESS_SELECT_CLASS} selectionClassName="bg-surface-selected" ariaLabel={t("settings.progress.color")} value={draft.colorMode} options={["semantic", "custom"].map((value) => ({ value, label: t(`settings.progress.color.${value}`) }))} onSelect={(value) => update({ colorMode: value as ProgressAppearance["colorMode"] })} />{draft.colorMode === "custom" && <input aria-label={t("settings.progress.customColor")} type="color" value={draft.customColor || "#679efe"} onChange={(event) => update({ customColor: event.target.value })} className="h-8 w-10 cursor-pointer rounded-input border border-border bg-transparent p-0.5" />}</div></SettingRow>
        <SettingRow label={t("settings.progress.speed")}><input aria-label={t("settings.progress.speed")} type="range" min="0.5" max="2" step="0.25" value={draft.speed} onChange={(event) => update({ speed: Number(event.target.value) })} className="w-40 accent-accent" /><span className="w-10 text-right font-mono text-ui-caption text-muted">{draft.speed}x</span></SettingRow>
      </div>
    </section>

    <section className="overflow-hidden rounded-card border border-faint bg-surface-2/40">
      <div className="border-b border-faint px-4 py-3"><h2 className="text-[13px] font-semibold text-text">{t("settings.progress.patterns")}</h2></div>
      <div className="divide-y divide-faint">
        {SLOTS.map((slot) => <SettingRow key={slot.id} label={t(slot.labelKey)} preview={<ProgressVisual slot={slot.id} config={draft} compact state={slot.id === "completed" ? "completed" : "running"} text={slot.sample} />}><SettingsSelectMenu variant="row" className={PROGRESS_SELECT_CLASS} selectionClassName="bg-surface-selected" ariaLabel={t(slot.labelKey)} value={draft.patterns[slot.id]} options={patternsForSlot(slot.id).map((pattern) => ({ value: pattern.id, label: t(pattern.labelKey) }))} onSelect={(value) => updatePattern(slot.id, value as ProgressAppearance["patterns"][ProgressSlot])} /></SettingRow>)}
      </div>
    </section>
  </div>;
}

function SettingRow({ label, children, preview }: { label: string; children: ReactNode; preview?: ReactNode }) {
  return <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2"><span className="min-w-[9rem] flex-1 text-ui-label font-medium text-text">{label}</span><div className="flex min-w-[12rem] flex-[0_1_20rem] items-center justify-end gap-3">{preview && <span className="flex h-8 min-w-12 shrink-0 items-center justify-center text-muted">{preview}</span>}{children}</div></div>;
}
