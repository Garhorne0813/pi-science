import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GLViewer } from "3dmol";
import { Atom, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  defaultStyleMode,
  isSmilesFile,
  looksLikeMacromolecule,
  moleculeFormatFor,
  smilesToMolblock,
  type MoleculeStyleMode,
} from "@/lib/viewers/molecule";
import { cn } from "@/lib/cn";

const STYLE_OPTIONS: Array<{ value: MoleculeStyleMode; key: string }> = [
  { value: "stick", key: "molecule.style.stick" },
  { value: "sphere", key: "molecule.style.sphere" },
  { value: "cartoon", key: "molecule.style.cartoon" },
];

/** The existing WebGL viewer, kept as the format and capability fallback. */
export function ThreeDMolMoleculeView({
  filename,
  text,
}: {
  filename: string;
  text: string;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<GLViewer | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const format = useMemo(() => moleculeFormatFor(filename), [filename]);
  const isMacromolecule = useMemo(() => looksLikeMacromolecule(text), [text]);
  const styleOptions = useMemo(
    () => STYLE_OPTIONS.filter((o) => o.value !== "cartoon" || isMacromolecule),
    [isMacromolecule],
  );

  const [styleMode, setStyleMode] = useState<MoleculeStyleMode>(() =>
    defaultStyleMode(filename, text),
  );
  const [isDragging, setIsDragging] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [atomCount, setAtomCount] = useState<number | null>(null);

  useEffect(() => {
    setStyleMode(defaultStyleMode(filename, text));
  }, [filename, text]);

  const resetView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.zoomTo();
    viewer.render();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !format) return;

    let cancelled = false;
    setRendering(true);
    setError(null);
    setAtomCount(null);
    container.replaceChildren();

    (async () => {
      try {
        const model = isSmilesFile(filename) ? await smilesToMolblock(text) : text;
        if (cancelled) return;
        if (!model) {
          setError(t("molecule.noStructures"));
          return;
        }

        const $3Dmol = await import("3dmol");
        if (cancelled || !containerRef.current) return;

        const viewer = $3Dmol.createViewer(containerRef.current, { backgroundColor: "white" });
        viewerRef.current = viewer;
        viewer.setBackgroundColor(0xffffff, 0);
        viewer.addModel(model, format);
        const count = viewer.selectedAtoms({}).length;
        if (count === 0) {
          setError(t("molecule.loadFailed"));
          return;
        }
        applyStyle(viewer, styleMode, isMacromolecule);
        viewer.zoomTo();
        viewer.render();
        setAtomCount(count);
        requestAnimationFrame(() => {
          if (!cancelled) {
            viewer.resize();
            viewer.render();
          }
        });
      } catch {
        if (!cancelled) setError(t("molecule.loadFailed"));
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
      dragRef.current = null;
      viewerRef.current?.clear();
      viewerRef.current = null;
      container.replaceChildren();
    };
  }, [filename, text, format, styleMode, isMacromolecule, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.resize();
      viewer.render();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('[data-molecule-controls="true"]')) return;
    if (event.button !== 0 || !viewerRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setIsDragging(true);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewer = viewerRef.current;
    if (!drag || !viewer || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    if (Math.abs(dx) > 0.1) viewer.rotate(dx * 0.45, "y");
    if (Math.abs(dy) > 0.1) viewer.rotate(dy * 0.45, "x");
    viewer.render();
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.zoom(event.deltaY > 0 ? 0.9 : 1.1);
    viewer.render();
  }, []);

  if (!format) return <div className="p-4 text-sm text-muted">{t("molecule.notChemical")}</div>;

  return (
    <div
      className={cn(
        "relative h-full min-h-[420px] w-full touch-none select-none overflow-hidden bg-white",
        isDragging ? "cursor-grabbing" : "cursor-grab",
      )}
      data-molecule-viewer="3dmol"
      onPointerDownCapture={onPointerDown}
      onPointerMoveCapture={onPointerMove}
      onPointerUpCapture={endDrag}
      onPointerCancelCapture={endDrag}
      onWheel={onWheel}
    >
      <div ref={containerRef} className="absolute inset-0" aria-label={t("molecule.viewerLabel")} />

      <div
        className="absolute left-3 top-3 flex items-center gap-2 rounded-input border border-border/70 bg-surface/90 p-1 shadow-card backdrop-blur"
        data-molecule-controls="true"
      >
        <div className="flex items-center gap-1 px-1.5 text-xs font-medium text-muted">
          <Atom size={13} /> {t("molecule.viewer.3dmol")}
        </div>
        <div className="flex rounded bg-surface-2 p-0.5">
          {styleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setStyleMode(option.value)}
              className={cn(
                "min-h-7 rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                styleMode === option.value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
              )}
            >
              {t(option.key)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={resetView}
          aria-label={t("molecule.resetView")}
          title={t("molecule.resetView")}
          className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <RotateCcw size={13} />
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-3 right-3 rounded-input border border-border/70 bg-surface/90 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
        <span className="font-medium text-text">{format.toUpperCase()}</span>
        {atomCount !== null && <span className="ml-2">{t("molecule.atomCount", { count: atomCount })}</span>}
      </div>

      {(rendering || error) && (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] rounded-input border border-border/70 bg-surface/95 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
          {rendering ? t("molecule.rendering") : error}
        </div>
      )}
    </div>
  );
}

function applyStyle(viewer: GLViewer, mode: MoleculeStyleMode, isMacromolecule: boolean) {
  if (mode === "sphere") {
    viewer.setStyle({}, { sphere: { colorscheme: "Jmol", scale: 0.36 } });
    return;
  }
  if (mode === "cartoon" && isMacromolecule) {
    viewer.setStyle({}, { cartoon: { color: "spectrum" } });
    viewer.setStyle({ hetflag: true }, { stick: { colorscheme: "Jmol", radius: 0.12 } });
    return;
  }
  viewer.setStyle({}, { stick: { colorscheme: "Jmol", radius: 0.18 }, sphere: { colorscheme: "Jmol", scale: 0.26 } });
}
