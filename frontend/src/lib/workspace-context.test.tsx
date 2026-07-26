import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WorkspaceProvider, useRequiredWorkspaceCwd, useWorkspaceCwd } from "./workspace-context";

afterEach(cleanup);

function Nullable() {
  const cwd = useWorkspaceCwd();
  return <span data-testid="cwd">{cwd === null ? "<null>" : cwd}</span>;
}

function Required() {
  return <span data-testid="cwd">{useRequiredWorkspaceCwd()}</span>;
}

/** Errors thrown during render are also logged by React; silence that noise. */
function renderExpectingThrow(element: React.ReactElement): unknown {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    render(element);
    return null;
  } catch (error) {
    return error;
  } finally {
    spy.mockRestore();
  }
}

function renderAt(path: string, pattern: string, element: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={<WorkspaceProvider>{element}</WorkspaceProvider>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("workspace context", () => {
  it("decodes the :cwd route param once for the subtree", () => {
    renderAt(`/workspace/${encodeURIComponent("/Users/me/my project")}/files`, "/workspace/:cwd/files", <Required />);
    expect(screen.getByTestId("cwd").textContent).toBe("/Users/me/my project");
  });

  it("reports null on routes without a :cwd param", () => {
    renderAt("/settings", "/settings", <Nullable />);
    expect(screen.getByTestId("cwd").textContent).toBe("<null>");
  });

  it("throws from the required variant outside a workspace route", () => {
    const error = renderExpectingThrow(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<WorkspaceProvider><Required /></WorkspaceProvider>} />
        </Routes>
      </MemoryRouter>,
    );
    expect((error as Error)?.message).toMatch(/outside a workspace route/);
  });

  it("throws when no provider is mounted", () => {
    const error = renderExpectingThrow(<Required />);
    expect((error as Error)?.message).toMatch(/inside <WorkspaceProvider>/);
  });
});
