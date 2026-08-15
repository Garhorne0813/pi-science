import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/ui";

/** Chat code block chrome: 12px radius shell with a sticky banner holding
 *  the fence language, optional extra actions (Run) and a copy button. The
 *  <pre> keeps its own horizontal scroll, so long lines never move the page;
 *  the banner sticks to the top of the message scroller while reading. */
export function CodeBlockFrame({
  language,
  code,
  preClassName,
  bannerExtra,
  children,
}: {
  language?: string | null;
  code: string;
  preClassName?: string;
  bannerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard access can be unavailable outside a secure browser context.
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-3 rounded-card bg-surface-2 text-[13px] leading-5">
      <div className="sticky top-0 z-[6] flex items-center gap-2 rounded-t-card border-b border-faint bg-surface-2 px-3 py-1.5">
        {language && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted">{language}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {bannerExtra}
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? t("conversation.copied") : t("conversation.copy")}
            title={copied ? t("conversation.copied") : t("conversation.copy")}
            className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-raised hover:text-text"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
      <pre className={cn("overflow-x-auto rounded-b-card p-3 font-mono [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-text", preClassName)}>
        {children}
      </pre>
    </div>
  );
}
