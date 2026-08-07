import { useEffect, useRef, useState } from "react";
import { Atom } from "lucide-react";
import { readArtifact } from "@/lib/files/files";
import { defaultStyleMode, moleculeFormatFor } from "@/lib/viewers/molecule";

/**
 * Structure-file thumbnail for artifact cards (Claude Science style): renders
 * the molecule with 3Dmol.js into a small static image instead of an icon.
 *
 * Cost controls:
 * - IntersectionObserver lazy-load: a WebGL viewer is only created once the
 *   card scrolls into view (multiple structure cards never all render at once).
 * - Global concurrency cap: at most MAX_CONCURRENT viewers render at a time;
 *   the rest queue behind them.
 * - Render-once: after `pngURI()` captures a static frame the viewer and its
 *   WebGL context are released, so the GPU is only touched for a few frames.
 *
 * A truncated file fragment is fine: 3Dmol renders whatever atoms it finds.
 */
const MOLECULE_SNIPPET_BYTES = 256 * 1024;
const MAX_CONCURRENT = 2;

let activeRenders = 0;
const renderQueue: Array<() => void> = [];

function acquire(onReady: () => void): void {
  if (activeRenders < MAX_CONCURRENT) {
    activeRenders += 1;
    onReady();
  } else {
    renderQueue.push(onReady);
  }
}

function release(): void {
  activeRenders -= 1;
  const next = renderQueue.shift();
  if (next) next();
}

function releaseWebGL(container: HTMLElement): void {
  const canvas = container.querySelector("canvas");
  if (!canvas) return;
  const ctx = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
  try {
    ctx?.getExtension?.("WEBGL_lose_context")?.loseContext?.();
  } catch {
    /* best-effort context release */
  }
  // Remove only the canvas 3Dmol appended; the container itself is owned by
  // React and must not be cleared directly (clearing it desyncs React's DOM).
  canvas.remove();
}

interface FakeViewerLike {
  setBackgroundColor: (color: number, alpha: number) => void;
  addModel: (data: string, format: string) => void;
  selectedAtoms: (sel: Record<string, unknown>) => Array<Record<string, unknown>>;
  setStyle: (sel: Record<string, unknown>, style: Record<string, unknown>) => void;
  zoomTo: () => void;
  render: () => void;
  pngURI: () => string;
  clear?: () => void;
}

export function MoleculeThumb({
  path,
  cwd,
  filename,
  onError,
}: {
  path: string;
  cwd: string;
  filename: string;
  /** Called when the fragment cannot be read or 3Dmol cannot render it, so the
   *  caller can fall back to an icon card. */
  onError?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
          return;
        }
      }
    }, { rootMargin: "120px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || text !== null || failed) return;
    let cancelled = false;
    void readArtifact(path, "workspace", cwd, MOLECULE_SNIPPET_BYTES)
      .then((file) => {
        if (cancelled) return;
        if (!file || file.encoding !== "utf8" || !file.data) {
          setFailed(true);
          onError?.();
          return;
        }
        setText(file.data);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          onError?.();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inView, path, cwd, text, failed, onError]);

  useEffect(() => {
    if (!text || image !== null || failed) return;
    const format = moleculeFormatFor(filename);
    if (!format) {
      setFailed(true);
      onError?.();
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let viewer: FakeViewerLike | null = null;
    const body = text;

    acquire(() => {
      void (async () => {
        try {
          const $3Dmol = await import("3dmol");
          if (cancelled || !containerRef.current) return;
          const created = $3Dmol.createViewer(containerRef.current, { backgroundColor: "white" }) as unknown as FakeViewerLike;
          viewer = created;
          created.setBackgroundColor(0xffffff, 0);
          created.addModel(body, format);
          if (created.selectedAtoms({}).length === 0) throw new Error("no atoms parsed");
          const mode = defaultStyleMode(filename, body);
          if (mode === "cartoon") {
            created.setStyle({}, { cartoon: { color: "spectrum" } });
            created.setStyle({ hetflag: true }, { stick: { colorscheme: "Jmol", radius: 0.12 } });
          } else {
            created.setStyle({}, { stick: { colorscheme: "Jmol", radius: 0.18 }, sphere: { colorscheme: "Jmol", scale: 0.26 } });
          }
          created.zoomTo();
          created.render();
          const dataUrl = created.pngURI();
          if (cancelled) return;
          setImage(dataUrl);
        } catch {
          if (!cancelled) {
            setFailed(true);
            onError?.();
          }
        } finally {
          if (cancelled) {
            release();
            return;
          }
          try {
            viewer?.clear?.();
          } catch {
            /* best-effort */
          }
          if (containerRef.current) releaseWebGL(containerRef.current);
          release();
        }
      })();
    });

    return () => {
      cancelled = true;
    };
  }, [text, image, failed, filename, path, cwd, onError]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" aria-hidden>
      {image ? (
        <img src={image} alt="" className="h-full w-full object-contain" />
      ) : failed ? (
        <div className="flex h-full w-full items-center justify-center">
          <Atom size={14} className="text-muted" />
        </div>
      ) : (
        <div className="h-full w-full animate-pulse bg-surface-2" />
      )}
    </div>
  );
}
