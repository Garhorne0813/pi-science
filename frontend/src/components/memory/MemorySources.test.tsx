import { beforeAll, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import i18n from "../../i18n";
import { MemorySources } from "./MemorySources";
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("does not open a file in the wrong project", () => {
  render(
    <MemorySources
      sources={[{ kind: "file", locator: "notes.md", projectId: "other" }]}
      cwd="project"
      projectId="current"
    />,
  );
  expect(
    screen.queryByRole("button", { name: "View current file" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByText("notes.md")[0]).toBeVisible();
});
it("reads the current referenced memory and warns about a different pinned version", async () => {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          record: {
            title: "Upstream note",
            body: "New evidence",
            revision: 2,
            contentHash: "new",
            status: "needs_review",
          },
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <MemorySources
      sources={[
        {
          kind: "memory",
          locator: "upstream",
          projectId: "current",
          version: "1",
          digest: "old",
        },
      ]}
      cwd="project"
      projectId="current"
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "View current source memory" }),
  );
  expect(await screen.findByText("New evidence")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "differs from the pinned reference",
  );
  expect(String(fetch.mock.calls[0]?.[0])).toContain(
    "/api/memory/records/upstream?cwd=project",
  );
});
it("ignores a late source response after the preview closes", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  render(
    <MemorySources
      sources={[{ kind: "memory", locator: "upstream", projectId: "current" }]}
      cwd="project"
      projectId="current"
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "View current source memory" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await act(async () => {
    resolve(
      new Response(
        JSON.stringify({ record: { title: "Late source", body: "Late" } }),
        { status: 200 },
      ),
    );
  });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.queryByText("Late source")).not.toBeInTheDocument();
});
