import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { sortProjects, WorkspaceCard } from "./ProjectsPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function Harness({ viewMode = "grid", togglePin = vi.fn() }: { viewMode?: "grid" | "list"; togglePin?: (path: string) => void }) {
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  return (
    <>
      <WorkspaceCard
        w={{ name: "Climate Study", path: "/tmp/Climate Study", project_id: "project-1", session_count: 2, last_modified: "2026-09-10T00:00:00Z" }}
        pinned={new Set()}
        togglePin={togglePin}
        editingName={editingName}
        setEditingName={setEditingName}
        editValue={editValue}
        setEditValue={setEditValue}
        handleRename={vi.fn()}
        handleDelete={vi.fn()}
        nameInputRef={createRef<HTMLInputElement>()}
        navigate={vi.fn()}
        timeAgo={() => "recently"}
        viewMode={viewMode}
      />
      <LocationProbe />
    </>
  );
}

describe("WorkspaceCard", () => {
  it("opens the workspace through a native full-card link", () => {
    render(<MemoryRouter><Harness /></MemoryRouter>);

    const link = screen.getByRole("link", { name: "Open Climate Study" });
    expect(link).toHaveAttribute("href", "/workspace/%2Ftmp%2FClimate%20Study");

    fireEvent.click(link);
    expect(screen.getByTestId("location")).toHaveTextContent("/workspace/%2Ftmp%2FClimate%20Study");
  });

  it("keeps pinning separate from navigation in list mode", () => {
    const togglePin = vi.fn();
    render(<MemoryRouter><Harness viewMode="list" togglePin={togglePin} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Pin to top" }));
    expect(togglePin).toHaveBeenCalledWith("/tmp/Climate Study");
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });
});

describe("sortProjects", () => {
  const projects = [
    { name: "Beta", path: "/beta", project_id: "2", session_count: 8, last_modified: "2026-09-01T10:00:00Z" },
    { name: "alpha", path: "/alpha", project_id: "1", session_count: 2, last_modified: "2026-09-12T10:00:00Z" },
    { name: "Gamma", path: "/gamma", project_id: "3", session_count: 5, last_modified: "2026-09-05T10:00:00Z" },
  ];
  it("sorts by activity without mutating the input", () => {
    expect(sortProjects(projects, "recent").map(p => p.name)).toEqual(["alpha", "Gamma", "Beta"]);
    expect(projects[0].name).toBe("Beta");
  });
  it("sorts names and conversation count", () => {
    expect(sortProjects(projects, "name").map(p => p.name)).toEqual(["alpha", "Beta", "Gamma"]);
    expect(sortProjects(projects, "sessions").map(p => p.name)).toEqual(["Beta", "Gamma", "alpha"]);
  });
});
