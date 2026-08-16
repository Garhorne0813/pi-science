const MAX_CACHE_ENTRIES = 64;

let sharedRenderer: Promise<import("./molstar").MolstarViewerHandle> | null = null;
let renderTail: Promise<void> = Promise.resolve();
const imageCache = new Map<string, string>();

export interface MoleculeThumbnailRequest {
  cacheKey: string;
  filename: string;
  text: string;
}

/**
 * Render thumbnails through one hidden Mol* instance. Serializing work avoids
 * creating a WebGL context per artifact card; cards only retain the PNG URI.
 */
export function renderMoleculeThumbnail(request: MoleculeThumbnailRequest): Promise<string> {
  const cached = imageCache.get(request.cacheKey);
  if (cached) {
    imageCache.delete(request.cacheKey);
    imageCache.set(request.cacheKey, cached);
    return Promise.resolve(cached);
  }

  let resolveTask!: (value: string) => void;
  let rejectTask!: (reason?: unknown) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  renderTail = renderTail.then(async () => {
    try {
      const renderer = await getSharedRenderer();
      await renderer.load(request.filename, request.text);
      renderer.resize();
      await nextPaint();
      const image = await renderer.captureImage();
      remember(request.cacheKey, image);
      resolveTask(image);
      await renderer.clear();
    } catch (cause) {
      rejectTask(cause);
    }
  }, async () => {
    // A failed predecessor must not poison the global queue.
    try {
      const renderer = await getSharedRenderer();
      await renderer.load(request.filename, request.text);
      renderer.resize();
      await nextPaint();
      const image = await renderer.captureImage();
      remember(request.cacheKey, image);
      resolveTask(image);
      await renderer.clear();
    } catch (cause) {
      rejectTask(cause);
    }
  });
  return result;
}

export function moleculeThumbnailCacheKey(cwd: string, path: string, text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${cwd}\0${path}\0${text.length}\0${hash >>> 0}`;
}

async function getSharedRenderer(): Promise<import("./molstar").MolstarViewerHandle> {
  if (!sharedRenderer) {
    sharedRenderer = (async () => {
      const host = document.createElement("div");
      host.dataset.moleculeThumbnailRenderer = "true";
      Object.assign(host.style, {
        position: "fixed",
        left: "-10000px",
        top: "-10000px",
        // Match the 128×55 artifact preview at 3× resolution. Using the same
        // aspect ratio prevents object-fit from letterboxing the screenshot.
        width: "384px",
        height: "165px",
        overflow: "hidden",
        pointerEvents: "none",
      });
      document.body.append(host);
      const { createMolstarViewer } = await import("./molstar");
      return createMolstarViewer(host, true);
    })();
  }
  return sharedRenderer;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function remember(key: string, image: string): void {
  imageCache.set(key, image);
  while (imageCache.size > MAX_CACHE_ENTRIES) {
    const oldest = imageCache.keys().next().value;
    if (oldest === undefined) break;
    imageCache.delete(oldest);
  }
}
