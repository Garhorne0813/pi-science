import { useState } from "react";
import { useTranslation } from "react-i18next";
import { request, responseError } from "../../../lib/client/http";
import type { CitationInlineStyle } from "../../../lib/settings/settings-types";
import { SettingsSelectMenu } from "../SettingsSelectMenu";

/** Server-persisted inline citation style. Like the verification switch it
 *  lives in config.json, so it applies to every workspace and survives a
 *  browser restart. */
export function CitationInlineStyleSettings({ style, onSaved }: { style: CitationInlineStyle; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (next: string) => {
    setSaving(true); setError("");
    try {
      const res = await request("/api/settings/citation-inline-style", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ style: next }) });
      const data = await res.json();
      if (!res.ok) throw new Error(responseError(data, t("settings.citationInlineStyle.saveError")));
      await onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setSaving(false); }
  };
  const label = t("settings.citationInlineStyle.title");
  return <section aria-label={label} className="space-y-3">
    <h3 className="text-ui-body font-medium text-text">{label}</h3>
    <p className="text-ui-caption leading-relaxed text-muted">{t("settings.citationInlineStyle.description")}</p>
    <SettingsSelectMenu
      ariaLabel={label}
      value={style}
      disabled={saving}
      variant="compact"
      options={[
        { value: "number", label: t("settings.citationInlineStyle.number"), hint: t("settings.citationInlineStyle.numberHint") },
        { value: "identifier", label: t("settings.citationInlineStyle.identifier"), hint: t("settings.citationInlineStyle.identifierHint") },
      ]}
      onSelect={(next) => void save(next)}
    />
    {error && <p role="alert" className="text-ui-caption text-error-text">{error}</p>}
  </section>;
}
