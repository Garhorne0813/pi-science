import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { WorkspaceCard } from "./ProjectsPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function Harness() {
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  return (
    <>
      <WorkspaceCard
        w={{ name: "Climate Study", path: "/tmp/Climate Study", project_id: "project-1", session_count: 2, last_modified: "2026-09-10T00:00:00Z" }}
        pinned={new Set()}
        togglePin={vi.fn()}
        editingName={editingName}
        setEditingName={setEditingName}
        editValue={editValue}
        setEditValue={setEditValue}
        handleRename={vi.fn()}
        handleDelete={vi.fn()}
        nameInputRef={createRef<HTMLInputElement>()}
        navigate={vi.fn()}
        timeAgo={() => "recently"}
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
});
