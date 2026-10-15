import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { QuestionnaireOption } from "../../lib/agent-runtime";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";

/** Details live outside the scroll body so they never increase the Composer height. */
export function QuestionnaireOptionDetails({ option, active, disabled }: { option: QuestionnaireOption; active: boolean; disabled: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState(false);
  const [allowHint, setAllowHint] = useState(true);
  useEffect(() => { if (!active || disabled) { setOpen(false); setHint(false); } }, [active, disabled]);
  if (!option.description && !option.preview) return null;
  return (
    <Popover.Root open={open && active} onOpenChange={(value) => { setOpen(value); if (value) { setAllowHint(false); setHint(false); } }}>
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root open={hint && allowHint && !open && active && !disabled} onOpenChange={setHint}>
          <Popover.Trigger asChild>
            <Tooltip.Trigger asChild>
              <button type="button" disabled={disabled} onPointerMove={() => { if (!open) setAllowHint(true); }} onBlur={() => { if (!open) setAllowHint(true); }} aria-label={t("interaction.previewOption", { option: option.label })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-input text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><Info size={14} /></button>
            </Tooltip.Trigger>
          </Popover.Trigger>
          {option.description && <Tooltip.Portal><Tooltip.Content side="top" collisionPadding={16} className="ui-popover z-50 max-w-[min(280px,calc(100vw-32px))] rounded-input px-3 py-2 text-xs text-text"><span className="line-clamp-3 break-words">{option.description}</span></Tooltip.Content></Tooltip.Portal>}
        </Tooltip.Root>
      </Tooltip.Provider>
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={8} collisionPadding={16} aria-label={t("interaction.previewOption", { option: option.label })} onEscapeKeyDown={(event) => event.stopPropagation()} onCloseAutoFocus={(event) => { if (!active) event.preventDefault(); }} className="ui-popover z-50 flex max-h-[min(360px,50dvh,var(--radix-popover-content-available-height))] w-[min(420px,calc(100vw-32px))] flex-col overflow-hidden rounded-card text-sm text-text">
          <div className="flex shrink-0 items-center gap-3 border-b border-faint px-4 py-2">
            <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
            <Popover.Close asChild><button type="button" aria-label={t("common.close")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-input text-muted hover:bg-surface-2"><X size={14} /></button></Popover.Close>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain break-words px-4 py-3">
            {option.description && <p className="mb-2 text-sm text-muted">{option.description}</p>}
            {option.preview && <MarkdownViewer>{option.preview}</MarkdownViewer>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
