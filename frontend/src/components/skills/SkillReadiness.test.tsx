import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import "../../i18n";
import { SkillReadinessBadge, RequirementStatusList } from "./SkillReadiness";
import type { SkillReadiness } from "../../lib/skills/skills-api";

const readyReadiness: SkillReadiness = {
  skill_id: "s1",
  ready: true,
  requirements: [{ name: "python", kind: "python", optional: false, version: "3.12.1", status: "ready" }],
};

const blockedReadiness: SkillReadiness = {
  skill_id: "s2",
  ready: false,
  requirements: [
    { name: "numpy", kind: "package", optional: false, status: "ready" },
    {
      name: "scanpy",
      kind: "package",
      optional: false,
      status: "missing",
      reason: 'Python package "scanpy" is not installed in /usr/bin/python3',
      hint: "pip install scanpy",
    },
    { name: "pypdf", kind: "package", optional: true, status: "missing-optional" },
  ],
};

describe("SkillReadinessBadge", () => {
  it("renders a ready pill for a ready skill", () => {
    render(<SkillReadinessBadge readiness={readyReadiness} />);
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("renders a needs-dependencies pill for a blocked skill", () => {
    render(<SkillReadinessBadge readiness={blockedReadiness} />);
    expect(screen.getByText("Needs dependencies")).toBeTruthy();
  });

  it("renders nothing for skills without requirements", () => {
    const { container } = render(<SkillReadinessBadge readiness={{ skill_id: "s3", ready: true, requirements: [] }} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a loading spinner while probing", () => {
    render(<SkillReadinessBadge loading />);
    expect(screen.getByLabelText("Checking dependencies")).toBeTruthy();
  });

  it("renders a neutral unable-to-check pill when the probe failed", () => {
    render(<SkillReadinessBadge readiness={undefined} error="boom" />);
    expect(screen.getByText("Unable to check dependencies")).toBeTruthy();
    expect(screen.getByTitle("boom")).toBeTruthy();
  });
});

describe("RequirementStatusList", () => {
  it("lists per-requirement status, reason and copyable hint", () => {
    render(<RequirementStatusList readiness={blockedReadiness} />);
    expect(screen.getByText("numpy")).toBeTruthy();
    expect(screen.getByText("scanpy")).toBeTruthy();
    expect(screen.getByText(/not installed/)).toBeTruthy();
    expect(screen.getByText("pip install scanpy")).toBeTruthy();
    // optional marker and per-status label are rendered
    expect(screen.getByText("missing (optional)")).toBeTruthy();
  });

  it("labels the copy button accessibly and announces the copied state", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<RequirementStatusList readiness={blockedReadiness} />);
    const button = screen.getByRole("button", { name: "Copy install hint" });
    button.click();
    expect(writeText).toHaveBeenCalledWith("pip install scanpy");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("reports a clipboard failure and recovers the hint label", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    render(<RequirementStatusList readiness={blockedReadiness} />);
    const button = screen.getByRole("button", { name: "Copy install hint" });
    button.click();
    expect(writeText).toHaveBeenCalledWith("pip install scanpy");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy failed" })).toBeTruthy());
    expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
  });

  it("clears the copy state after the timer and stays mounted", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<RequirementStatusList readiness={blockedReadiness} />);
    screen.getByRole("button", { name: "Copy install hint" }).click();
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy install hint" })).toBeTruthy(), { timeout: 3000 });
  });

  it("stays functional under StrictMode double-invoke (copy success)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <StrictMode>
        <RequirementStatusList readiness={blockedReadiness} />
      </StrictMode>,
    );
    screen.getByRole("button", { name: "Copy install hint" }).click();
    expect(writeText).toHaveBeenCalledWith("pip install scanpy");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("stays functional under StrictMode double-invoke (copy failure)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <StrictMode>
        <RequirementStatusList readiness={blockedReadiness} />
      </StrictMode>,
    );
    screen.getByRole("button", { name: "Copy install hint" }).click();
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy failed" })).toBeTruthy());
    expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
  });

  it("does not repeat the optional marker for missing-optional status", () => {
    render(<RequirementStatusList readiness={blockedReadiness} />);
    // 'missing (optional)' is the status label itself; no extra '· optional' span.
    expect(screen.getByText("missing (optional)")).toBeTruthy();
    expect(screen.queryByText("· optional")).toBeNull();
  });

  it("marks the aggregate as blocked when a required dependency is missing", () => {
    render(<RequirementStatusList readiness={blockedReadiness} />);
    expect(screen.getByText("Missing required dependencies")).toBeTruthy();
  });

  it("renders nothing for an empty requirement list", () => {
    const { container } = render(<RequirementStatusList readiness={{ skill_id: "s3", ready: true, requirements: [] }} />);
    expect(container.firstChild).toBeNull();
  });
});
