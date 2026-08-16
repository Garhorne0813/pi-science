import { useEffect, useRef, useState } from "react";
import { Atom } from "lucide-react";
import { readArtifact, type ArtifactFile } from "@/lib/files/files";
import { moleculeThumbnailCacheKey, renderMoleculeThumbnail } from "@/lib/viewers/molecule-thumbnail";

const MOLECULE_SNIPPET_BYTES = 256 * 1024;
const MOLECULE_THUMBNAIL_MAX_BYTES = 16 * 1024 * 1024;

async function readCompleteMolecule(path: string, cwd: string): Promise<ArtifactFile | null> {
  const snippet = await readArtifact(path, "workspace", cwd, MOLECULE_SNIPPET_BYTES);
  if (!snippet?.truncated) return snippet;

  // Structure formats are commonly ordered by chain. Rendering a prefix can
  // therefore turn a dimer into an apparently valid monomer. Fetch the whole
  // local file when it is reasonably sized; otherwise show the fallback card
  // instead of a scientifically misleading partial thumbnail.
  const complete = await readArtifact(path, "workspace", cwd, MOLECULE_THUMBNAIL_MAX_BYTES);
  return complete?.truncated ? null : complete;
}

/**
 * Static structure thumbnail backed by the process-wide Mol* renderer queue.
 * The card itself never owns a viewer or WebGL context.
 */
export function MoleculeThumb({
  path,
  cwd,
  filename,
  onError,
}: {
  path: string;
  cwd: string;
  filename: string;
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
    void readCompleteMolecule(path, cwd)
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
    let cancelled = false;
    const cacheKey = moleculeThumbnailCacheKey(cwd, path, text);
    void renderMoleculeThumbnail({ cacheKey, filename, text })
      .then((dataUrl) => {
        if (!cancelled) setImage(dataUrl);
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
  }, [text, image, failed, filename, path, cwd, onError]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" aria-hidden>
      {image ? (
        <img src={image} alt="" className="block h-full w-full object-cover" />
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
