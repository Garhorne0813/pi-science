import { useEffect, useRef, useState } from "react";
import { Atom } from "lucide-react";
import { useTranslation } from "react-i18next";
import { moleculeFormatFor } from "@/lib/viewers/molecule";
import { INSPECTOR_LAYOUT_CHANGE_EVENT } from "@/lib/ui/inspector-layout";
import {
  createMolstarViewer,
  type MolecularSummary,
  type MoleculeStylePreset,
  type MolstarViewerHandle,
} from "@/lib/viewers/molstar";

const STYLE_PRESETS: Array<{ id: MoleculeStylePreset; labelKey: string }> = [
  { id: "auto", labelKey: "molecule.style.auto" },
  { id: "cartoon", labelKey: "molecule.style.cartoon" },
  { id: "ball-and-stick", labelKey: "molecule.style.ballAndStick" },
  { id: "spacefill", labelKey: "molecule.style.spacefill" },
  { id: "surface", labelKey: "molecule.style.surface" },
];

/**
 * Local-first Mol* structure viewer. Embedded Mol* controls expose structure
 * representations, coloring, selections, measurements, screenshots, settings
 * and the sequence panel without sending the loaded file to a remote service.
 */
export function MoleculeView({ filename, text }: { filename: string; text: string }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<MolstarViewerHandle | null>(null);
  const generationRef = useRef(0);
  const [summary, setSummary] = useState<MolecularSummary | null>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stylePreset, setStylePreset] = useState<MoleculeStylePreset>("auto");
  const [styleBusy, setStyleBusy] = useState(false);
  const format = moleculeFormatFor(filename, text);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !format) return;
    const generation = ++generationRef.current;
    let disposed = false;
    setRendering(true);
    setError(null);
    setSummary(null);
    setStylePreset("auto");
    setStyleBusy(false);

    void (async () => {
      try {
        const handle = await createMolstarViewer(container);
        if (disposed || generation !== generationRef.current) {
          handle.dispose();
          return;
        }
        viewerRef.current = handle;
        const next = await handle.load(filename, text);
        if (disposed || generation !== generationRef.current) return;
        setSummary(next);
      } catch {
        if (!disposed && generation === generationRef.current) setError(t("molecule.loadFailed"));
      } finally {
        if (!disposed && generation === generationRef.current) setRendering(false);
      }
    })();

    return () => {
      disposed = true;
      generationRef.current += 1;
      const handle = viewerRef.current;
      viewerRef.current = null;
      handle?.dispose();
    };
  }, [filename, text, format, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let previousWidth = container.clientWidth;
    let previousHeight = container.clientHeight;
    let resizeFrame: number | null = null;
    let fitFrame: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let fitPending = false;
    const resizeAndFit = () => {
      viewerRef.current?.resize();
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        viewerRef.current?.fitToViewport();
      });
      // Mol* animates camera changes for 160ms. A second pass after it settles
      // prevents a stale maximize animation from winning over a restore, and
      // catches pane layouts whose final canvas size lands a frame later.
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        viewerRef.current?.resize();
        viewerRef.current?.fitToViewport();
      }, 200);
    };
    const scheduleResize = (refit: boolean) => {
      fitPending ||= refit;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (!fitPending) {
          viewerRef.current?.resize();
          return;
        }
        fitPending = false;
        resizeAndFit();
      });
    };
    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(-1)?.contentRect ?? container.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      if (previousWidth > 0 && previousHeight > 0 && width > 0 && height > 0) {
        if (Math.abs(width - previousWidth) > 1 || Math.abs(height - previousHeight) > 1) {
          fitPending = true;
        }
      }
      previousWidth = width;
      previousHeight = height;
      scheduleResize(fitPending);
    });
    const handleInspectorLayoutChange = () => scheduleResize(true);
    observer.observe(container);
    window.addEventListener(INSPECTOR_LAYOUT_CHANGE_EVENT, handleInspectorLayoutChange);
    return () => {
      observer.disconnect();
      window.removeEventListener(INSPECTOR_LAYOUT_CHANGE_EVENT, handleInspectorLayoutChange);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      if (settleTimer !== null) clearTimeout(settleTimer);
    };
  }, []);

  const changeStyle = async (preset: MoleculeStylePreset) => {
    const handle = viewerRef.current;
    if (!handle || rendering || styleBusy) return;
    setStyleBusy(true);
    setError(null);
    try {
      await handle.applyStylePreset(preset);
      setStylePreset(preset);
    } catch {
      setError(t("molecule.styleFailed"));
    } finally {
      setStyleBusy(false);
    }
  };

  if (!format) return <div className="p-4 text-sm text-muted">{t("molecule.notChemical")}</div>;

  return (
    <div className="flex h-full min-h-[420px] w-full flex-col overflow-hidden bg-[var(--doc-paper)]" data-molecule-viewer="true">
      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1.5"
        role="toolbar"
        aria-label={t("molecule.styleToolbar")}
      >
        {STYLE_PRESETS.map(({ id, labelKey }) => (
          <button
            key={id}
            type="button"
            aria-pressed={stylePreset === id}
            disabled={rendering || styleBusy || !summary}
            onClick={() => void changeStyle(id)}
            className={`shrink-0 rounded-[5px] px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              stylePreset === id ? "bg-accent text-white" : "text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" aria-label={t("molecule.viewerLabel")} />
        <div className="ui-popover pointer-events-none absolute bottom-3 right-3 z-10 rounded-input bg-surface/90 px-3 py-1.5 text-xs text-muted backdrop-blur">
          <span className="inline-flex items-center gap-1 font-medium text-text"><Atom size={12} /> Mol*</span>
          <span className="ml-2">{(summary?.format ?? format).toUpperCase()}</span>
          {summary && <span className="ml-2">{t("molecule.atomCount", { count: summary.atomCount })}</span>}
        </div>
        {(rendering || error) && (
          <div className="ui-popover pointer-events-none absolute bottom-3 left-3 z-10 max-w-[70%] rounded-input bg-surface/95 px-3 py-1.5 text-xs text-muted backdrop-blur">
            {rendering ? t("molecule.rendering") : error}
          </div>
        )}
      </div>
    </div>
  );
}
