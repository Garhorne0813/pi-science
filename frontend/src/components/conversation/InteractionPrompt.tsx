import { useEffect, useState } from "react";
import type { PendingInteraction } from "../../lib/runtime-store";
import { useTranslation } from "react-i18next";

export function InteractionPrompt({
  interaction,
  onRespond,
}: {
  interaction: PendingInteraction;
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(interaction.prefill || "");

  useEffect(() => {
    setValue(interaction.prefill || "");
  }, [interaction.requestId, interaction.prefill]);

  const options = (interaction.options || []).map((option) => (
    typeof option === "string"
      ? { label: option, value: option }
      : { label: option.label || option.value || t("interaction.option"), value: option.value || option.label || "" }
  ));

  return (
    <div className="rounded-card border border-accent/30 bg-accent/5 p-4 animate-fadeIn">
      <div className="text-sm font-medium text-text">{interaction.title}</div>
      {interaction.message && <div className="mt-1 text-sm leading-relaxed text-muted">{interaction.message}</div>}

      {interaction.method === "confirm" ? (
        <div className="mt-3 flex gap-2">
          <button onClick={() => onRespond({ confirmed: true })} className="rounded-input bg-accent px-3 py-1.5 text-xs text-accent-fg">{t("common.confirm")}</button>
          <button onClick={() => onRespond({ confirmed: false })} className="rounded-input border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-2">{t("interaction.decline")}</button>
        </div>
      ) : interaction.method === "select" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map((option) => (
            <button
              key={`${option.label}-${option.value}`}
              onClick={() => onRespond({ value: option.value })}
              className="rounded-input border border-border bg-surface px-3 py-1.5 text-xs text-text hover:border-accent"
            >
              {option.label}
            </button>
          ))}
          <button onClick={() => onRespond({ cancelled: true })} className="rounded-input px-3 py-1.5 text-xs text-muted hover:bg-surface-2">{t("common.cancel")}</button>
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
            onClick={() => onRespond({ value })}
            disabled={!value.trim()}
            className="rounded-input bg-accent px-3 py-2 text-xs text-accent-fg disabled:cursor-default disabled:opacity-50"
          >
            {t("common.submit")}
          </button>
          <button onClick={() => onRespond({ cancelled: true })} className="rounded-input px-2 py-2 text-xs text-muted hover:bg-surface-2">{t("common.cancel")}</button>
        </div>
      )}
    </div>
  );
}
