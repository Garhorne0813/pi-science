import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";

const patinae = vi.hoisted(() => {
  const state = {
    initError: null as Error | null,
    instances: [] as Array<Instance>,
  };

  type Listener = (message: { level: string; text: string }) => void;

  class Instance {
    private listeners = new Map<string, Listener>();
    readonly init = vi.fn(async () => {
      if (state.initError) throw state.initError;
    });
    readonly loadData = vi.fn();
    readonly execute = vi.fn((_command: string) => ({ messages: [] }));
    readonly executeAsync = vi.fn(async (command: string) => {
      this.listeners.get("command-output")?.({ level: "info", text: `ran ${command}` });
      return { messages: [] };
    });
    readonly countAtoms = vi.fn(() => 42);
    readonly destroy = vi.fn();

    constructor(_container: HTMLElement, _options?: unknown) {
      state.instances.push(this);
    }

    on(event: string, callback: Listener) {
      this.listeners.set(event, callback);
    }
  }

  return { state, Instance };
});

vi.mock("@patinae/viewer", () => ({ PatinaeViewer: patinae.Instance }));

import { PatinaeMoleculeView } from "./PatinaeMoleculeView";

function renderViewer(onUnavailable?: (message: string) => void) {
  return render(
    <I18nextProvider i18n={i18n}>
      <PatinaeMoleculeView
        filename="protein.pdb"
        text="ATOM      1  CA  ALA A   1       0.000   0.000   0.000"
        onUnavailable={onUnavailable}
      />
    </I18nextProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  patinae.state.initError = null;
  patinae.state.instances.length = 0;
});

afterEach(cleanup);

describe("PatinaeMoleculeView", () => {
  it("initializes lazily and runs commands entered in the console", async () => {
    renderViewer();

    const input = screen.getByRole("textbox", { name: "Patinae command" });
    await waitFor(() => expect(input).toBeEnabled());

    const viewer = patinae.state.instances[0];
    expect(viewer).toBeDefined();
    expect(viewer?.loadData).toHaveBeenCalledOnce();

    fireEvent.change(input, { target: { value: "color green" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(viewer?.executeAsync).toHaveBeenCalledWith("color green"));
    expect(await screen.findByText("ran color green")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("destroys the viewer when unmounted", async () => {
    const { unmount } = renderViewer();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Patinae command" })).toBeEnabled());

    const viewer = patinae.state.instances[0];
    unmount();

    expect(viewer?.destroy).toHaveBeenCalledOnce();
  });

  it("reports initialization failures so the parent can fall back", async () => {
    patinae.state.initError = new Error("WebGPU unavailable");
    const onUnavailable = vi.fn();
    renderViewer(onUnavailable);

    expect(await screen.findByText("Patinae could not start: WebGPU unavailable")).toBeInTheDocument();
    expect(onUnavailable).toHaveBeenCalledWith("Patinae could not start: WebGPU unavailable");
    expect(screen.getByRole("textbox", { name: "Patinae command" })).toBeDisabled();
  });
});
