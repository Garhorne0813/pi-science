import { SettingsSaveMode } from "./SettingsSaveMode";
import { useSettingsDraftStatus } from "./SettingsDraftStatus";
import { SettingsToggle } from "./SettingsToggle";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MemorySettings } from "@pi-science/contracts";
import { Section } from "./Section";
import { SettingsRow } from "./SettingsRow";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

const draftKey = "pi-science.memory-settings-draft";
export function clearMemorySettingsDraft() { try { sessionStorage.removeItem(draftKey); } catch { /* storage unavailable */ } }

const inputClass =
  "h-10 w-full min-w-0 max-w-full rounded-input border border-border bg-bg px-3 text-ui-label text-text outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50";

export function MemorySettingsForm({
  value,
  busy,
  save,
  models = [],
  onDirtyChange,
}: {
  models?: Array<{ value: string; label: string }>;
  onDirtyChange?: (dirty: boolean) => void;
  value: MemorySettings;
  busy: boolean;
  save: (value: Omit<MemorySettings, "revision">) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [s, set] = useState(() => { try { const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null"); if (draft?.recall && draft?.extraction && draft?.dream && draft?.budget && draft?.review) return draft as MemorySettings; } catch { /* invalid draft */ } return value; });
  const dirty = JSON.stringify(s) !== JSON.stringify(value);
  useSettingsDraftStatus("memory", dirty);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { try { if (dirty) sessionStorage.setItem(draftKey, JSON.stringify(s)); else clearMemorySettingsDraft(); } catch { /* storage unavailable */ } }, [s, dirty]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, [dirty]);
  const toggle = (
    label: string,
    checked: boolean,
    change: (next: boolean) => void,
  ) => (
    <SettingsRow label={t(`memory.${label}`)} inline>
      <SettingsToggle label={t(`memory.${label}`)} checked={checked} disabled={busy} onChange={change} />
    </SettingsRow>
  );
  const number = (
    label: string,
    value: number,
    change: (next: number) => void,
  ) => (
    <SettingsRow label={t(`memory.${label}`)}>
      <input
        type="number"
        step={label === "dailyCostUsd" ? 0.01 : 1}
        aria-label={t(`memory.${label}`)}
        value={value}
        disabled={busy}
        onChange={(e) => change(Number(e.target.value))}
        className={inputClass + " sm:w-28"}
      />
    </SettingsRow>
  );
  const select = (
    label: string,
    value: string,
    options: Array<{ value: string; label: string }>,
    change: (next: string) => void,
    disabled = false,
  ) => (
    <SettingsSelectMenu
      ariaLabel={t(`memory.${label}`)}
      value={value}
      options={options}
      onSelect={change}
      disabled={busy || disabled}
      variant="row"
      className="w-full max-w-none justify-between sm:w-auto"
    />
  );
  const model = (kind: "extraction" | "dream") => (
    <SettingsRow
      label={t(
        kind === "extraction" ? "memory.extractionModel" : "memory.dreamModel",
      )}
      description={t("memory.modelHelp")}
    >
      <SettingsSelectMenu
        ariaLabel={t(
          kind === "extraction"
            ? "memory.extractionModel"
            : "memory.dreamModel",
        )}
        value={s[kind].model}
        options={[
          { value: "inherit", label: t("memory.inheritModel") },
          ...models,
          ...(s[kind].model !== "inherit" &&
          !models.some((m) => m.value === s[kind].model)
            ? [
                {
                  value: s[kind].model,
                  label: s[kind].model + " · " + t("memory.modelUnavailable"),
                },
              ]
            : []),
        ]}
        disabled={busy}
        searchable
        onSelect={(model) => set({ ...s, [kind]: { ...s[kind], model } })}
        variant="field"
        className="w-full sm:w-60"
      />
    </SettingsRow>
  );
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const { revision: _, ...rest } = s;
        void save(rest);
      }}
    >
      <SettingsSaveMode />
      {!s.enabled && <p className="text-ui-caption text-muted">{t("settings.consistency.memoryDisabled")}</p>}
      {s.revision !== value.revision && <p role="alert" className="text-ui-body text-warn-text">{t("memory.draftConflict")}</p>}
      <Section title={t("memory.title")}>
        <div className="divide-y divide-faint">
          {toggle("enable", s.enabled, (v) => set({ ...s, enabled: v }))}
          {s.enabled && (
            <>
              {toggle("autoRecall", s.recall.enabled, (v) =>
                set({ ...s, recall: { ...s.recall, enabled: v } }),
              )}
              <SettingsRow
                label={t("memory.reviewMode")}
                description={t("memory.reviewExplanation")}
              >
                {select(
                  "reviewMode",
                  s.review.mode,
                  ["smart", "all_manual"].map((mode) => ({
                    value: mode,
                    label: t(`memory.${mode}`),
                  })),
                  (mode) =>
                    set({
                      ...s,
                      review: {
                        ...s.review,
                        mode: mode as MemorySettings["review"]["mode"],
                      },
                      dream: { ...s.dream, updatePolicy: "suggest_only" },
                    }),
                )}
              </SettingsRow>
            </>
          )}
        </div>
      </Section>
      {s.enabled && (
        <>
          <Section title={t("memory.extraction")}>
            <div className="divide-y divide-faint">
              {toggle("enableExtraction", s.extraction.enabled, (v) =>
                set({ ...s, extraction: { ...s.extraction, enabled: v } }),
              )}
              {s.extraction.enabled && (
                <>
                  {model("extraction")}
                  {number("minMessages", s.extraction.minMessages, (v) =>
                    set({
                      ...s,
                      extraction: { ...s.extraction, minMessages: v },
                    }),
                  )}
                </>
              )}
            </div>
          </Section>
          <Section title={t("memory.dream")}>
            <div className="divide-y divide-faint">
              {toggle("enableDream", s.dream.enabled, (v) =>
                set({ ...s, dream: { ...s.dream, enabled: v } }),
              )}
              {s.dream.enabled && (
                <>
                  <SettingsRow label={t("memory.mode")}>
                    {select(
                      "mode",
                      s.dream.mode,
                      ["manual", "idle", "interval", "window"].map((mode) => ({
                        value: mode,
                        label: t(`memory.${mode}`),
                      })),
                      (mode) =>
                        set({
                          ...s,
                          dream: {
                            ...s.dream,
                            mode: mode as MemorySettings["dream"]["mode"],
                          },
                        }),
                    )}
                  </SettingsRow>
                  {model("dream")}
                  <SettingsRow
                    label={t("memory.updatePolicy")}
                    description={t(
                      s.review.mode === "all_manual"
                        ? "memory.manualDreamPolicy"
                        : s.dream.updatePolicy === "suggest_only"
                          ? "memory.suggestOnly"
                          : "memory.autoLowRisk",
                    )}
                  >
                    {select(
                      "updatePolicy",
                      s.dream.updatePolicy,
                      [
                        {
                          value: "suggest_only",
                          label: t("memory.suggestOnlyLabel"),
                        },
                        {
                          value: "auto_low_risk",
                          label: t("memory.autoLowRiskLabel"),
                        },
                      ],
                      (policy) =>
                        set({
                          ...s,
                          dream: {
                            ...s.dream,
                            updatePolicy:
                              policy as MemorySettings["dream"]["updatePolicy"],
                          },
                        }),
                      s.review.mode === "all_manual",
                    )}
                  </SettingsRow>
                </>
              )}
            </div>
          </Section>
          {s.dream.enabled && (
            <details className="rounded-card border border-faint p-4"><summary className="cursor-pointer text-ui-label font-medium">{t("settings.consistency.runConditions")}</summary><p className="my-3 text-ui-caption text-muted">{t("settings.consistency.runConditionsHelp")}</p><Section title={t("memory.schedule")}>
              <div className="divide-y divide-faint">
                {toggle("windowEnabled", s.dream.allowedWindow.enabled, (v) =>
                  set({
                    ...s,
                    dream: {
                      ...s.dream,
                      allowedWindow: { ...s.dream.allowedWindow, enabled: v },
                    },
                  }),
                )}
                {s.dream.allowedWindow.enabled &&
                  (["start", "end", "timeZone"] as const).map((field) => (
                    <SettingsRow key={field} label={t(`memory.${field}`)}>
                      <input
                        type={field === "timeZone" ? "text" : "time"}
                        aria-label={t(`memory.${field}`)}
                        value={s.dream.allowedWindow[field]}
                        disabled={busy}
                        onChange={(e) =>
                          set({
                            ...s,
                            dream: {
                              ...s.dream,
                              allowedWindow: {
                                ...s.dream.allowedWindow,
                                [field]: e.target.value,
                              },
                            },
                          })
                        }
                        className={
                          inputClass +
                          (field === "timeZone" ? " sm:w-52" : " sm:w-36")
                        }
                      />
                    </SettingsRow>
                  ))}
                {toggle("requireIdle", s.dream.requireIdle, (v) =>
                  set({ ...s, dream: { ...s.dream, requireIdle: v } }),
                )}
                {s.dream.mode !== "manual" &&
                  toggle("oncePerWindow", s.dream.oncePerWindow, (v) =>
                    set({ ...s, dream: { ...s.dream, oncePerWindow: v } }),
                  )}
                {(
                  [
                    "idleMinutes",
                    "minNewItems",
                    "intervalHours",
                    "minIntervalHours",
                    "maxRuntimeMinutes",
                  ] as const
                )
                  .filter(
                    (field) =>
                      (field !== "idleMinutes" || s.dream.requireIdle) &&
                      (field !== "intervalHours" ||
                        s.dream.mode === "interval"),
                  )
                  .map((field) => (
                    <div key={field}>
                      {number(field, s.dream[field], (v) =>
                        set({ ...s, dream: { ...s.dream, [field]: v } }),
                      )}
                    </div>
                  ))}
              </div>
            </Section></details>
          )}
          <Section title={t("memory.budget")}>
            <p className="pb-2 text-ui-caption leading-relaxed text-muted">
              {t("memory.sharedBudget")}
            </p>
            <div className="divide-y divide-faint">
              {(["dailyTokens", "perRunTokens", "dailyCostUsd"] as const).map(
                (field) => (
                  <div key={field}>
                    {number(field, s.budget[field], (v) =>
                      set({ ...s, budget: { ...s.budget, [field]: v } }),
                    )}
                  </div>
                ),
              )}
            </div>
          </Section>
        </>
      )}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-surface-raised py-card">
        <p aria-live="polite" className="mr-auto text-ui-caption text-muted">{dirty ? t("memory.draftKept") : t("memory.noChanges")}</p>
        {dirty && <button type="button" disabled={busy} className="text-ui-label text-muted" onClick={() => { clearMemorySettingsDraft(); set(value); }}>{t("common.discard")}</button>}
        <button
          type="submit"
          disabled={busy || !dirty}
          className="flex min-h-10 items-center gap-2 rounded-input bg-accent-fill px-3 text-ui-caption font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {t(busy ? "common.saving" : "memory.save")}
        </button>
      </div>
    </form>
  );
}
