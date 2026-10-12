import { ViewerStatusBar } from "./PreviewFrame";
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
const RENDER_TIMEOUT_MS = 45_000;

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
  const [retry, setRetry] = useState(0);
  const format = moleculeFormatFor(filename, text);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !format) return;
    const generation = ++generationRef.current;
    let disposed = false;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      if (disposed || generation !== generationRef.current) return;
      timedOut = true;
      viewerRef.current?.dispose();
      viewerRef.current = null;
      setError(t("molecule.renderTimeout"));
      setRendering(false);
    }, RENDER_TIMEOUT_MS);
    setRendering(true);
    setError(null);
    setSummary(null);
    setStylePreset("auto");
    setStyleBusy(false);

    void (async () => {
      let handle: Awaited<ReturnType<typeof createMolstarViewer>>;
      try {
        handle = await createMolstarViewer(container);
      } catch (cause) {
        console.error("Failed to initialize Mol* viewer", cause);
        if (!disposed && !timedOut && generation === generationRef.current) setError(t("molecule.viewerFailed"));
        if (!disposed && !timedOut && generation === generationRef.current) setRendering(false);
        window.clearTimeout(timeout);
        return;
      }

      try {
        if (disposed || timedOut || generation !== generationRef.current) {
          handle.dispose();
          return;
        }
        viewerRef.current = handle;
        const next = await handle.load(filename, text);
        if (disposed || timedOut || generation !== generationRef.current) return;
        setSummary(next);
      } catch (cause) {
        console.error("Failed to load molecular structure", cause);
        if (!disposed && !timedOut && generation === generationRef.current) setError(t("molecule.loadFailed"));
      } finally {
        window.clearTimeout(timeout);
        if (!disposed && !timedOut && generation === generationRef.current) setRendering(false);
      }
    })();

    return () => {
      window.clearTimeout(timeout);
      disposed = true;
      generationRef.current += 1;
      const handle = viewerRef.current;
      viewerRef.current = null;
      handle?.dispose();
    };
  }, [filename, text, format, t, retry]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let resizeFrame: number | null = null;
    const scheduleResize = () => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        // Resizing the viewport must preserve the camera and selections.
        viewerRef.current?.resize();
      });
    };
    const observer = new ResizeObserver(scheduleResize);
    const handleInspectorLayoutChange = scheduleResize;
    observer.observe(container);
    window.addEventListener(INSPECTOR_LAYOUT_CHANGE_EVENT, handleInspectorLayoutChange);
    return () => {
      observer.disconnect();
      window.removeEventListener(INSPECTOR_LAYOUT_CHANGE_EVENT, handleInspectorLayoutChange);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
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
    <div className="flex h-full min-h-[420px] w-full flex-col overflow-hidden bg-surface" data-molecule-viewer="true">
      <div
        className="preview-toolbar"
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
            className={`preview-control shrink-0 disabled:cursor-not-allowed disabled:opacity-50 ${
              stylePreset === id ? "bg-surface-selected text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" aria-label={t("molecule.viewerLabel")} />
        {(rendering || error) && (
          <div className={`ui-popover absolute bottom-3 left-3 z-10 max-w-[70%] rounded-input bg-surface/95 px-3 py-1.5 text-xs text-muted backdrop-blur ${error && !rendering ? "pointer-events-auto" : "pointer-events-none"}`}>
            {rendering ? t("molecule.rendering") : <>{error} <button type="button" className="ml-2 text-link underline" onClick={() => setRetry((value) => value + 1)}>{t("molecule.retry")}</button></>}
          </div>
        )}
      </div>
        <ViewerStatusBar>
          <span className="inline-flex items-center gap-1 font-medium text-text"><Atom size={12} /> Mol*</span>
          <span className="ml-2">{(summary?.format ?? format).toUpperCase()}</span>
          {summary && <span className="ml-2">{t("molecule.atomCount", { count: summary.atomCount })}</span>}
        </ViewerStatusBar>
    </div>
  );
}
