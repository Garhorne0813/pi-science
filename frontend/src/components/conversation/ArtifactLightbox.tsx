import { Suspense, lazy, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, X } from "lucide-react";
import { previewUrl, readArtifact } from "../../lib/files";
import type { TurnArtifactItem } from "../../types/thread";
import { cn } from "../../lib/ui";

/** Structure files can be large (multi-MB PDB/CIF); cap the lightbox read so
 *  the modal stays responsive. 3Dmol renders the first atoms it can parse,
 *  which is enough for inspection. */
const STRUCTURE_MAX_BYTES = 4 * 1024 * 1024;

/** Interactive 3Dmol viewer is heavy (WebGL): load it on first open only. */
const MoleculeView = lazy(() =>
  import("../inspector/MoleculeView").then((m) => ({ default: m.MoleculeView })),
);

function LightboxBody({ item, cwd, partial, onPartial }: {
  item: TurnArtifactItem;
  cwd?: string;
  partial: boolean;
  onPartial: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ status: "loading" } | { status: "error" } | { status: "ready"; text: string }>(
    item.kind === "image" ? { status: "ready", text: "" } : { status: "loading" },
  );

  useEffect(() => {
    if (item.kind === "image" || !cwd) return;
    let cancelled = false;
    setState({ status: "loading" });
    void readArtifact(item.path, "workspace", cwd, STRUCTURE_MAX_BYTES)
      .then((file) => {
        if (cancelled) return;
        if (!file || file.encoding !== "utf8" || !file.data) {
          setState({ status: "error" });
          return;
        }
        onPartial(file.truncated === true);
        setState({ status: "ready", text: file.data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.path, item.kind, cwd]);

  if (item.kind === "image") {
    return (
      <img
        src={previewUrl(item.path, "workspace", cwd ?? "")}
        alt={item.path.split("/").pop() ?? item.path}
        className="mx-auto max-h-[70vh] w-auto max-w-full object-contain"
      />
    );
  }

  if (state.status === "loading") {
    return (
      <div className="flex h-[50vh] items-center justify-center text-sm text-muted" role="status">
        <Loader2 size={18} className="mr-2 animate-spin text-accent" aria-hidden />
        {t("common.loading")}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex h-[40vh] items-center justify-center text-sm text-error">
        {t("conversation.lightboxLoadError")}
      </div>
    );
  }
  return (
    <div className="relative">
      {partial && (
        <div className="mb-2 rounded-input border border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
          {t("conversation.lightboxStructurePartial")}
        </div>
      )}
      <Suspense fallback={(
        <div className="flex h-[50vh] items-center justify-center text-sm text-muted" role="status">
          <Loader2 size={18} className="mr-2 animate-spin text-accent" aria-hidden />
          {t("common.loading")}
        </div>
      )}>
        <MoleculeView filename={item.path.split("/").pop() ?? item.path} text={state.text} />
      </Suspense>
    </div>
  );
}

/** Centered lightbox modal for image and structure artifact cards.
 *  Images are shown at full size; structures get an interactive 3Dmol viewer.
 *  Escape / overlay click / close button dismiss; Radix Dialog owns focus. */
export function ArtifactLightbox({ item, cwd, open, onOpenChange }: {
  item: TurnArtifactItem | null;
  cwd?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [partial, setPartial] = useState(false);
  const filename = item?.path.split("/").pop() ?? "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[95] bg-black/65 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-[96] flex max-h-[85vh] w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none",
            "max-w-[min(90vw,900px)]",
          )}
        >
          <div className="flex items-center gap-2 border-b border-faint px-4 py-2.5">
            <Dialog.Title className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">
              {filename}
            </Dialog.Title>
            {item && (item.kind === "structure") && (
              <span className="shrink-0 rounded-full border border-border px-2 py-px text-[10px] text-muted">
                {item.path.split(".").pop()?.toUpperCase() ?? "STRUCTURE"}
              </span>
            )}
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t("common.close")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                <X size={15} />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-surface-2/40 p-4">
            {item && <LightboxBody item={item} cwd={cwd} partial={partial} onPartial={setPartial} />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
