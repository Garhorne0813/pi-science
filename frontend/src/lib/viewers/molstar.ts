import type { Viewer } from "molstar/lib/apps/viewer/app";
import type { ViewerOptions } from "molstar/lib/apps/viewer/options";
import type { PluginUIContext } from "molstar/lib/mol-plugin-ui/context";
import { Color } from "molstar/lib/mol-util/color";
import "molstar/build/viewer/molstar.css";
import { isSmilesFile, moleculeFormatFor, smilesToMolblock, type MoleculeFormat } from "./molecule";

export interface MolecularSummary {
  atomCount: number;
  hasSequence: boolean;
  format: MoleculeFormat;
}

export type MoleculeStylePreset = "auto" | "cartoon" | "ball-and-stick" | "spacefill" | "surface";

export interface MolstarViewerHandle {
  readonly viewer: Viewer;
  load(filename: string, text: string): Promise<MolecularSummary>;
  applyStylePreset(preset: MoleculeStylePreset): Promise<void>;
  captureImage(): Promise<string>;
  clear(): Promise<void>;
  resize(): void;
  fitToViewport(): void;
  dispose(): void;
}

// Normal inspector canvas is approximately 420×500 CSS pixels. Larger
// canvases should use more of the available screen area instead of retaining
// Mol*'s conservative, nearly constant vertical occupancy.
const REFERENCE_VIEWPORT_AREA = 420 * 500;
const MIN_FIT_RADIUS_SCALE = 0.72;
const MAX_FIT_RADIUS_SCALE = 1.12;

// Mol*'s bundled React 18 renderer does not retain the root returned by
// createRoot(), so Viewer.dispose() cannot unmount it. Keep ownership here and
// serialize viewers that target the same element. This is especially important
// for React Strict Mode, fast file switching, and Vite hot updates.
const targetRelease = new WeakMap<HTMLElement, Promise<void>>();

export async function createMolstarViewer(target: HTMLElement, compact = false): Promise<MolstarViewerHandle> {
  const previousRelease = targetRelease.get(target) ?? Promise.resolve();
  let releaseTarget!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseTarget = resolve;
  });
  targetRelease.set(target, previousRelease.catch(() => undefined).then(() => released));
  await previousRelease.catch(() => undefined);

  let unmountUi = () => {};
  let targetReleased = false;
  const release = () => {
    if (targetReleased) return;
    targetReleased = true;
    releaseTarget();
  };

  const options = {
    customFormats: [],
    extensions: [],
    layoutIsExpanded: false,
    layoutShowControls: !compact,
    layoutShowRemoteState: false,
    layoutShowSequence: !compact,
    layoutShowLog: false,
    layoutShowLeftPanel: false,
    collapseLeftPanel: true,
    collapseRightPanel: true,
    volumeStreamingDisabled: true,
    viewportShowReset: !compact,
    viewportShowScreenshotControls: !compact,
    viewportShowControls: !compact,
    viewportShowExpand: false,
    viewportShowToggleFullscreen: false,
    viewportShowSettings: !compact,
    viewportShowSelectionMode: !compact,
    viewportShowAnimation: false,
    viewportShowTrajectoryControls: false,
    viewportFocusBehavior: compact ? "disabled" : "default",
    viewportBackgroundColor: "#ffffff",
  } satisfies Partial<ViewerOptions>;

  let viewer: Viewer;
  try {
    const [{ Viewer }, { createPluginUI }, { createViewerSpec }, { ViewerAutoPreset }, { createRoot }] = await Promise.all([
      import("molstar/lib/apps/viewer/app"),
      import("molstar/lib/mol-plugin-ui"),
      import("molstar/lib/apps/viewer/plugin-spec"),
      import("molstar/lib/apps/viewer/presets"),
      import("react-dom/client"),
    ]);
    const plugin = await createPluginUI({
      target,
      spec: createViewerSpec(options),
      render: (element, mountTarget) => {
        const root = createRoot(mountTarget);
        unmountUi = () => root.unmount();
        root.render(element);
      },
      onBeforeUIRender: (context) => {
        context.builders.structure.representation.registerPreset(ViewerAutoPreset);
      },
    });
    viewer = new Viewer(plugin);
    viewer.plugin.canvas3d?.setProps({ renderer: { backgroundColor: Color(0xffffff) } });
  } catch (error) {
    unmountUi();
    release();
    throw error;
  }

  let disposed = false;

  return {
    viewer,
    load: (filename, text) => loadMolecule(viewer, filename, text, compact),
    applyStylePreset: (preset) => applyStylePreset(viewer.plugin, preset),
    captureImage: async () => {
      const helper = viewer.plugin.helpers.viewportScreenshot;
      if (helper) return helper.getImageDataUri();
      const canvas = target.querySelector("canvas");
      if (!canvas) throw new Error("Mol* did not create a canvas");
      return canvas.toDataURL("image/png");
    },
    clear: () => viewer.plugin.clear(),
    resize: () => viewer.handleResize(),
    fitToViewport: () => fitToViewport(viewer, compact),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unmountUi();
      unmountUi = () => {};
      viewer.dispose();
      release();
    },
  };
}

function fitToViewport(viewer: Viewer, compact: boolean): void {
  viewer.handleResize();
  const canvas3d = viewer.plugin.canvas3d;
  if (!canvas3d) return;
  // requestCameraReset is resolved during a later scene commit. A pure layout
  // resize does not necessarily produce one, so update the Canvas3D viewport
  // and camera directly using the new aspect ratio.
  canvas3d.handleResize();
  const sphere = canvas3d.boundingSphereVisible;
  if (sphere.radius <= 0) return;
  const canvas = viewer.plugin.canvas3dContext?.canvas;
  const viewportArea = (canvas?.clientWidth ?? 0) * (canvas?.clientHeight ?? 0);
  const radiusScale = compact || viewportArea <= 0
    ? 1
    : Math.min(MAX_FIT_RADIUS_SCALE, Math.max(MIN_FIT_RADIUS_SCALE, Math.sqrt(REFERENCE_VIEWPORT_AREA / viewportArea)));
  const focus = canvas3d.camera.getFocus(sphere.center, sphere.radius * radiusScale);
  canvas3d.camera.setState({
    ...focus,
    radiusMax: Math.max(canvas3d.boundingSphere.radius, sphere.radius),
  }, 160);
}

const REPRESENTATION_PRESETS: Record<MoleculeStylePreset, string> = {
  auto: "preset-structure-representation-auto",
  cartoon: "preset-structure-representation-polymer-and-ligand",
  "ball-and-stick": "preset-structure-representation-atomic-detail",
  spacefill: "preset-structure-representation-illustrative",
  surface: "preset-structure-representation-molecular-surface",
};

async function applyStylePreset(plugin: PluginUIContext, preset: MoleculeStylePreset): Promise<void> {
  const structures = plugin.managers.structure.hierarchy.current.structures;
  if (!structures.length) throw new Error("No structure is loaded");
  const provider = plugin.builders.structure.representation.resolveProvider(REPRESENTATION_PRESETS[preset]);
  if (!provider) throw new Error(`Mol* representation preset is unavailable: ${preset}`);
  await plugin.managers.structure.component.applyPreset(structures, provider);
}

async function loadMolecule(viewer: Viewer, filename: string, sourceText: string, compact: boolean): Promise<MolecularSummary> {
  const text = isSmilesFile(filename) ? await smilesToMolblock(sourceText) : sourceText;
  if (!text) throw new Error("No structures found");
  const format = moleculeFormatFor(filename, text);
  if (!format) throw new Error("Unsupported molecular format");

  await viewer.plugin.clear();
  if (format === "cube") await loadCube(viewer.plugin, filename, text);
  else await viewer.loadStructureFromData(text, format, { dataLabel: filename });
  viewer.handleResize();

  const structures = viewer.plugin.managers.structure.hierarchy.current.structures;
  const atomCount = structures.reduce((total, structure) => total + (structure.cell.obj?.data.elementCount ?? 0), 0);
  const hasSequence = structures.some((structure) => {
    const data = structure.cell.obj?.data;
    if (!data) return false;
    return data.models.some((model) => model.atomicHierarchy.derived.residue.moleculeType.length > 0);
  });
  if (atomCount === 0) throw new Error("No atoms parsed");
  fitToViewport(viewer, compact);
  return { atomCount, hasSequence, format };
}

async function loadCube(plugin: PluginUIContext, filename: string, text: string): Promise<void> {
  const data = await plugin.builders.data.rawData({ data: text, label: filename });
  const provider = plugin.dataFormats.get("cube");
  if (!provider) throw new Error("Mol* CUBE provider is unavailable");
  const parsed = await provider.parse(plugin, data);
  if (provider.visuals) await provider.visuals(plugin, parsed);
}
