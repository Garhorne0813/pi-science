import { useState } from "react";
import { useTranslation } from "react-i18next";
import { request, responseError } from "../../../lib/client/http";

/** Server-persisted switch for automatic citation verification. The value
 *  lives in config.json, so it applies to every workspace and survives a
 *  browser restart. */
export function CitationAutoVerifySettings({ enabled, onSaved }: { enabled: boolean; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (next: boolean) => {
    setSaving(true); setError("");
    try {
      const res = await request("/api/settings/citation-auto-verify", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
      const data = await res.json();
      if (!res.ok) throw new Error(responseError(data, t("settings.citationAutoVerify.saveError")));
      await onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setSaving(false); }
  };
  const label = t("settings.citationAutoVerify.title");
  return <section aria-label={label} className="space-y-3">
    <h3 className="text-ui-body font-medium text-text">{label}</h3>
    <p className="text-ui-caption leading-relaxed text-muted">{t("settings.citationAutoVerify.description")}</p>
    <div className="flex items-center gap-3">
      <button type="button" role="switch" aria-checked={enabled} aria-label={label} disabled={saving} onClick={() => void save(!enabled)}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${enabled ? "border-accent bg-accent-fill" : "border-border bg-surface-inset"}`}>
        <span aria-hidden="true" className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full ${enabled ? "right-0.5 bg-accent-fg" : "left-0.5 bg-muted"}`} />
      </button>
      <span className="text-ui-caption text-text">{enabled ? t("settings.citationAutoVerify.on") : t("settings.citationAutoVerify.off")}</span>
    </div>
    {error && <p role="alert" className="text-ui-caption text-error-text">{error}</p>}
  </section>;
}
