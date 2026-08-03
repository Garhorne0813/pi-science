import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../i18n";
import { SkillDetail } from "./SkillsPage";

vi.mock("../../lib/skills/skills-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/skills/skills-api")>();
  return {
    ...actual,
    skillsApi: {
      ...actual.skillsApi,
      content: vi.fn(async () => ({
        skill_id: "alpha",
        name: "alpha",
        digest: "abc123",
        source: "builtin",
        location: ".pi/skills/alpha/SKILL.md",
        content: "---\nname: alpha\n---\n\n# Body\n\nTest content",
      })),
    },
  };
});

const skill = {
  skill_id: "alpha",
  digest: "abc123",
  name: "alpha",
  description: "Test skill",
  version: "0.1.0",
  category: "test",
  license: "MIT",
  risk: "low" as const,
  location: ".pi/skills/alpha/SKILL.md",
  source: "builtin",
};

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SkillDetail skill={skill} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("SkillDetail tabs", () => {
  it("associates tabs with panels via aria-controls and aria-labelledby", () => {
    renderDetail();
    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    const sourceTab = screen.getByRole("tab", { name: "SKILL.md" });
    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(panels).toHaveLength(2);
    // Every aria-controls reference must resolve to a mounted panel.
    for (const tab of [overviewTab, sourceTab]) {
      const controlId = tab.getAttribute("aria-controls");
      expect(controlId).toBeTruthy();
      const panel = document.getElementById(controlId as string);
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }
    const overviewPanel = document.getElementById(overviewTab.getAttribute("aria-controls") as string);
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(overviewPanel?.getAttribute("hidden")).toBeNull();
    const sourcePanel = document.getElementById(sourceTab.getAttribute("aria-controls") as string);
    expect(sourcePanel?.getAttribute("hidden")).not.toBeNull();
  });

  it("moves focus and selection with ArrowRight and ArrowLeft", () => {
    renderDetail();
    const tablist = screen.getByRole("tablist");
    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    const sourceTab = screen.getByRole("tab", { name: "SKILL.md" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(overviewTab.tabIndex).toBe(0);
    expect(sourceTab.tabIndex).toBe(-1);

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(sourceTab.getAttribute("aria-selected")).toBe("true");
    expect(overviewTab.tabIndex).toBe(-1);
    expect(sourceTab.tabIndex).toBe(0);
    expect(document.activeElement).toBe(sourceTab);

    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(overviewTab);
  });

  it("jumps to first and last tab with Home and End", () => {
    renderDetail();
    const tablist = screen.getByRole("tablist");
    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    const sourceTab = screen.getByRole("tab", { name: "SKILL.md" });

    fireEvent.keyDown(tablist, { key: "End" });
    expect(sourceTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(sourceTab);

    fireEvent.keyDown(tablist, { key: "Home" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(overviewTab);
  });

  it("renders preview content when the source tab is active", async () => {
    renderDetail();
    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(panels).toHaveLength(2);
    expect(panels[0].getAttribute("hidden")).toBeNull(); // overview visible
    expect(panels[1].getAttribute("hidden")).not.toBeNull(); // source lazily hidden
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(await screen.findByText("Test content")).toBeTruthy();
    const after = screen.getAllByRole("tabpanel", { hidden: true });
    expect(after).toHaveLength(2);
    expect(after[0].getAttribute("hidden")).not.toBeNull(); // overview now hidden
    expect(after[1].getAttribute("hidden")).toBeNull(); // source now visible
    expect(after[1].id).toMatch(/panel-source$/);
  });
});
