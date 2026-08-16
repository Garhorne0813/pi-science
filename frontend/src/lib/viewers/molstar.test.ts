import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMolstarViewer } from "./molstar";

const mocks = vi.hoisted(() => {
  const canvasSize = { width: 420, height: 500 };
  const focus = { target: [1, 2, 3], position: [4, 5, 6], radius: 12 };
  const camera = {
    getFocus: vi.fn(() => focus),
    setState: vi.fn(),
  };
  const canvas3d = {
    handleResize: vi.fn(),
    setProps: vi.fn(),
    camera,
    boundingSphereVisible: { center: [1, 2, 3], radius: 12 },
    boundingSphere: { center: [1, 2, 3], radius: 18 },
  };
  const viewer = {
    plugin: {
      canvas3d,
      canvas3dContext: {
        canvas: {
          get clientWidth() { return canvasSize.width; },
          get clientHeight() { return canvasSize.height; },
        },
      },
      clear: vi.fn(),
      builders: {
        structure: {
          representation: { registerPreset: vi.fn() },
        },
      },
    },
    handleResize: vi.fn(),
    dispose: vi.fn(),
  };
  const root = { render: vi.fn(), unmount: vi.fn() };
  return {
    focus,
    camera,
    canvas3d,
    canvasSize,
    viewer,
    root,
    createPluginUI: vi.fn(async (options) => {
      options.onBeforeUIRender?.(viewer.plugin);
      options.render(null, options.target);
      return viewer.plugin;
    }),
  };
});

vi.mock("molstar/lib/apps/viewer/app", () => ({
  Viewer: class {
    constructor() {
      return mocks.viewer;
    }
  },
}));
vi.mock("molstar/lib/mol-plugin-ui", () => ({ createPluginUI: mocks.createPluginUI }));
vi.mock("molstar/lib/apps/viewer/plugin-spec", () => ({ createViewerSpec: vi.fn(() => ({})) }));
vi.mock("molstar/lib/apps/viewer/presets", () => ({ ViewerAutoPreset: {} }));
vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => mocks.root) }));

describe("Mol* viewport fitting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canvasSize.width = 420;
    mocks.canvasSize.height = 500;
  });

  it("unmounts the owned React root before disposing Mol*", async () => {
    const handle = await createMolstarViewer(document.createElement("div"));

    handle.dispose();
    handle.dispose();

    expect(mocks.root.unmount).toHaveBeenCalledOnce();
    expect(mocks.viewer.dispose).toHaveBeenCalledOnce();
    expect(mocks.root.unmount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.viewer.dispose.mock.invocationCallOrder[0],
    );
  });

  it("updates the Canvas3D viewport before deriving a new camera focus", async () => {
    const handle = await createMolstarViewer(document.createElement("div"));

    handle.fitToViewport();

    expect(mocks.viewer.handleResize).toHaveBeenCalledOnce();
    expect(mocks.canvas3d.handleResize).toHaveBeenCalledOnce();
    expect(mocks.camera.getFocus).toHaveBeenCalledWith(mocks.canvas3d.boundingSphereVisible.center, 12);
    expect(mocks.camera.setState).toHaveBeenCalledWith({ ...mocks.focus, radiusMax: 18 }, 160);
    expect(mocks.canvas3d.handleResize.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.camera.getFocus.mock.invocationCallOrder[0],
    );
  });

  it("increases structure occupancy when the full viewer canvas grows", async () => {
    const handle = await createMolstarViewer(document.createElement("div"));
    mocks.canvasSize.width = 1_200;
    mocks.canvasSize.height = 500;

    handle.fitToViewport();

    expect(mocks.camera.getFocus).toHaveBeenCalledWith(mocks.canvas3d.boundingSphereVisible.center, 12 * 0.72);
  });

  it("keeps conservative fitting for compact thumbnail rendering", async () => {
    const handle = await createMolstarViewer(document.createElement("div"), true);
    mocks.canvasSize.width = 1_200;
    mocks.canvasSize.height = 500;

    handle.fitToViewport();

    expect(mocks.camera.getFocus).toHaveBeenCalledWith(mocks.canvas3d.boundingSphereVisible.center, 12);
  });
});
