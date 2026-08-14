import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanCard } from "./PlanCard";
import i18n from "../../i18n";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("PlanCard", () => {
  it("renders title, version, steps and statuses", () => {
    render(<PlanCard
      title="Refactor pipeline"
      version="v2"
      steps={[
        { label: "Extract loader", status: "done" },
        { label: "Port to ESM", status: "current" },
        { label: "Update tests", status: "pending" },
        { label: "Nightly flake", status: "blocked" },
      ]}
      onApprove={() => {}}
    />);
    expect(screen.getByText("Refactor pipeline")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.getByText("Extract loader")).toBeTruthy();
    expect(screen.getByText("Port to ESM")).toBeTruthy();
    expect(screen.getByText("Update tests")).toBeTruthy();
    expect(screen.getByText("Nightly flake")).toBeTruthy();
  });

  it("calls approve and request-changes handlers", () => {
    const approve = vi.fn();
    const changes = vi.fn();
    render(<PlanCard title="Plan" steps={[{ label: "Step one" }]} onApprove={approve} onRequestChanges={changes} />);
    fireEvent.click(screen.getByText("Approve plan"));
    expect(approve).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Request changes"));
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("renders artifact refs and the note", () => {
    render(<PlanCard
      title="Plan"
      steps={[{ label: "Generate figures", status: "done", artifactRefs: ["figures/plot-a.png", "figures/plot-b.png"] }]}
      onApprove={() => {}}
      note="Reviewer asked for error bars"
    />);
    expect(screen.getByText("figures/plot-a.png")).toBeTruthy();
    expect(screen.getByText("figures/plot-b.png")).toBeTruthy();
    expect(screen.getByText("Reviewer asked for error bars")).toBeTruthy();
  });

  it("disables approve while approving", () => {
    const approve = vi.fn();
    render(<PlanCard title="Plan" steps={[{ label: "Step" }]} onApprove={approve} approving />);
    fireEvent.click(screen.getByText("Approve plan"));
    expect(approve).not.toHaveBeenCalled();
  });
});
