import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PendingInteraction } from "../../lib/agent-runtime";
import { useTranslation } from "react-i18next";
import { PermissionCard } from "./interactions/PermissionCard";

export function InteractionPrompt({
  interaction,
  onRespond,
}: {
  interaction: PendingInteraction;
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(interaction.prefill || "");
  const [submitting, setSubmitting] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(interaction.prefill || "");
    setSubmitting(false);
    setSelectedOption(null);
    setError(null);
  }, [interaction.requestId, interaction.prefill]);

  const respond = async (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    if (submitting) return;
    setSubmitting(true);
    setSelectedOption(typeof response.value === "string" ? response.value : null);
    setError(null);
    try {
      await onRespond(response);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("interaction.responseFailed"));
      setSubmitting(false);
      setSelectedOption(null);
    }
  };

  const options = (interaction.options || []).map((option) => (
    typeof option === "string"
      ? { label: option, value: option }
      : { label: option.label || option.value || t("interaction.option"), value: option.value || option.label || "" }
  ));

  const permission = interaction.kind === "permission"
    || /\b(permission|approval|allow|deny)\b/i.test(`${interaction.title} ${interaction.message ?? ""}`);

  if (permission) {
    return <>
      <PermissionCard interaction={interaction} submitting={submitting} selectedOption={selectedOption} onRespond={(response) => { void respond(response); }} />
      {error && <p role="alert" className="mt-3 rounded-input border border-error/30 bg-error/5 px-3 py-2 text-xs text-error-text">{error}</p>}
    </>;
  }

  return (
    <div className="rounded-card border border-accent/30 bg-accent/5 p-4 animate-fadeIn">
      <div className="text-sm font-medium text-text">{interaction.title}</div>
      {interaction.message && <div className="mt-1 text-sm leading-relaxed text-muted">{interaction.message}</div>}

      {interaction.method === "confirm" ? (
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={submitting} onClick={() => void respond({ confirmed: true })} className="inline-flex items-center gap-1.5 rounded-input bg-accent-fill px-3 py-1.5 text-xs text-accent-fg disabled:opacity-50">{submitting && <Loader2 size={12} className="animate-spin" />}{t("common.confirm")}</button>
          <button type="button" disabled={submitting} onClick={() => void respond({ confirmed: false })} className="rounded-input border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-2 disabled:opacity-50">{t("interaction.decline")}</button>
        </div>
      ) : interaction.method === "select" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map((option) => (
            <button
              type="button"
              key={`${option.label}-${option.value}`}
              disabled={submitting}
              onClick={() => void respond({ value: option.value })}
              className="inline-flex items-center gap-1.5 rounded-input border border-border bg-surface px-3 py-1.5 text-xs text-text hover:border-accent disabled:opacity-50"
            >
              {submitting && selectedOption === option.value && <Loader2 size={12} className="animate-spin" />}
              {option.label}
            </button>
          ))}
          <button type="button" disabled={submitting} onClick={() => void respond({ cancelled: true })} className="rounded-input px-3 py-1.5 text-xs text-muted hover:bg-surface-2 disabled:opacity-50">{t("common.cancel")}</button>
        </div>
      ) : (
        <div className="mt-3 flex items-end gap-2">
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={interaction.placeholder}
            rows={interaction.method === "editor" ? 4 : 2}
            className="min-h-10 flex-1 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void respond({ value })}
            disabled={!value.trim() || submitting}
            className="rounded-input bg-accent-fill px-3 py-2 text-xs text-accent-fg disabled:cursor-default disabled:opacity-50"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" aria-label={t("questionnaire.submitting")} /> : t("common.submit")}
          </button>
          <button type="button" disabled={submitting} onClick={() => void respond({ cancelled: true })} className="rounded-input px-2 py-2 text-xs text-muted hover:bg-surface-2 disabled:opacity-50">{t("common.cancel")}</button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-input border border-error/30 bg-error/5 px-3 py-2 text-xs text-error-text">{error}</p>}
    </div>
  );
}
