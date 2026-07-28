import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  browserSupportsWebGpu,
  defaultViewerKind,
  supportsPatinaeFile,
  type MoleculeViewerKind,
} from "@/lib/viewers/patinae";
import { isSmilesFile, looksLikeMacromolecule } from "@/lib/viewers/molecule";
import { cn } from "@/lib/cn";
import { PatinaeMoleculeView } from "./PatinaeMoleculeView";
import { ThreeDMolMoleculeView } from "./ThreeDMolMoleculeView";

export function MoleculeView({ filename, text }: { filename: string; text: string }) {
  const { t } = useTranslation();
  const isMacromolecule = useMemo(() => looksLikeMacromolecule(text), [text]);
  const webGpuAvailable = browserSupportsWebGpu();
  const patinaeAllowed = useMemo(
    () => !isSmilesFile(filename) && supportsPatinaeFile(filename) && webGpuAvailable,
    [filename, webGpuAvailable],
  );
  const initialKind = useMemo(
    () => defaultViewerKind({ filename, isMacromolecule, webGpuAvailable }),
    [filename, isMacromolecule, webGpuAvailable],
  );

  const [viewerKind, setViewerKind] = useState<MoleculeViewerKind>(initialKind);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  useEffect(() => {
    setViewerKind(initialKind);
    setFallbackNotice(null);
  }, [filename, initialKind, text]);

  const handlePatinaeUnavailable = useCallback((message: string) => {
    setFallbackNotice(message);
    setViewerKind("3dmol");
  }, []);

  return (
    <div className="relative h-full min-h-[420px] w-full overflow-hidden">
      {viewerKind === "patinae" ? (
        <PatinaeMoleculeView
          filename={filename}
          text={text}
          onUnavailable={handlePatinaeUnavailable}
        />
      ) : (
        <ThreeDMolMoleculeView filename={filename} text={text} />
      )}

      <div
        className="absolute right-3 top-3 z-20 flex rounded-input border border-border/70 bg-surface/90 p-0.5 shadow-card backdrop-blur"
        data-molecule-viewer-switch="true"
      >
        <ViewerButton
          active={viewerKind === "3dmol"}
          onClick={() => setViewerKind("3dmol")}
          title={t("molecule.viewer.3dmol")}
        >
          {t("molecule.viewer.3dmol")}
        </ViewerButton>
        <ViewerButton
          active={viewerKind === "patinae"}
          disabled={!patinaeAllowed}
          title={patinaeAllowed ? t("molecule.viewer.patinae") : t("molecule.patinae.unavailable")}
          onClick={() => {
            setFallbackNotice(null);
            setViewerKind("patinae");
          }}
        >
          {t("molecule.viewer.patinae")}
        </ViewerButton>
      </div>

      {fallbackNotice && viewerKind === "3dmol" && (
        <div
          className="pointer-events-none absolute right-3 top-14 z-20 max-w-[70%] rounded-input border border-amber-500/30 bg-surface/95 px-3 py-2 text-xs text-muted shadow-card"
          role="status"
        >
          {t("molecule.patinae.fallback", { message: fallbackNotice })}
        </div>
      )}
    </div>
  );
}

function ViewerButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "min-h-7 rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {children}
    </button>
  );
}
