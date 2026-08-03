import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { SkillContentPreview } from "./SkillContentPreview";
import { skillsApi } from "../../lib/skills/skills-api";

const frontMatterContent =
  "---\nname: alpha\ndescription: Fixture skill\nlicense: MIT\n---\n## Steps\n\n1. Run the analysis.";

function renderPreview(skillId: string, cwd?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SkillContentPreview skillId={skillId} cwd={cwd} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  vi.spyOn(skillsApi, "content").mockResolvedValue({
    skill_id: "alpha",
    name: "alpha",
    digest: "0123456789abcdef",
    source: "project",
    location: ".pi/skills/alpha/SKILL.md",
    content: frontMatterContent,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SkillContentPreview", () => {
  it("renders body markdown and collapses front matter by default", async () => {
    renderPreview("alpha", "/ws");
    await waitFor(() => expect(screen.getByText("Steps")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Run the analysis.")).toBeTruthy());
    expect(screen.getByText("Front matter").closest("details")?.open).toBeFalsy();
    expect(screen.getByText(".pi/skills/alpha/SKILL.md")).toBeTruthy();
    expect(screen.getByText("0123456789abcdef")).toBeTruthy();
  });

  it("expands front matter details on click", async () => {
    renderPreview("alpha");
    const summary = await screen.findByText("Front matter");
    await userEvent.click(summary);
    await waitFor(() => expect(screen.getByText("Front matter").closest("details")?.open).toBe(true));
  });

  it("renders content without front matter directly", async () => {
    vi.spyOn(skillsApi, "content").mockResolvedValue({
      skill_id: "bare",
      name: "bare",
      digest: "abcdef0123456789",
      source: "builtin",
      location: "bare/SKILL.md",
      content: "# Bare\n\nNo front matter here.",
    });
    renderPreview("bare");
    expect(await screen.findByText("No front matter here.")).toBeTruthy();
    expect(screen.queryByText("Front matter")).toBeNull();
  });

  it("shows a loading state while pending", async () => {
    let resolve!: (value: unknown) => void;
    vi.spyOn(skillsApi, "content").mockReturnValue(new Promise((res) => { resolve = res; }));
    renderPreview("alpha");
    expect(screen.getByText("Loading…")).toBeTruthy();
    resolve({
      skill_id: "alpha",
      name: "alpha",
      digest: "0123456789abcdef",
      source: "project",
      location: ".pi/skills/alpha/SKILL.md",
      content: frontMatterContent,
    });
    await waitFor(() => expect(screen.getByText("Steps")).toBeTruthy());
  });

  it("shows an error with a working retry button", async () => {
    const contentSpy = vi.spyOn(skillsApi, "content");
    contentSpy.mockRejectedValueOnce(new Error("boom"));
    contentSpy.mockResolvedValue({
      skill_id: "alpha",
      name: "alpha",
      digest: "0123456789abcdef",
      source: "project",
      location: ".pi/skills/alpha/SKILL.md",
      content: frontMatterContent,
    });
    renderPreview("alpha");
    expect(await screen.findByRole("alert")).toBeTruthy();
    await userEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByText("Steps")).toBeTruthy());
    expect(contentSpy).toHaveBeenCalledTimes(2);
  });

  it("does not show stale content after the skill id changes", async () => {
    let resolveFirst!: (value: unknown) => void;
    const contentSpy = vi.spyOn(skillsApi, "content");
    contentSpy.mockReturnValueOnce(new Promise((res) => { resolveFirst = res; }));
    contentSpy.mockResolvedValue({
      skill_id: "beta",
      name: "beta",
      digest: "fedcba9876543210",
      source: "builtin",
      location: "beta/SKILL.md",
      content: "# Beta\n\nSecond skill body.",
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <SkillContentPreview skillId="alpha" cwd="/ws" />
      </QueryClientProvider>,
    );
    rerender(
      <QueryClientProvider client={client}>
        <SkillContentPreview skillId="beta" cwd="/ws" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Second skill body.")).toBeTruthy());
    resolveFirst({
      skill_id: "alpha",
      name: "alpha",
      digest: "0123456789abcdef",
      source: "project",
      location: ".pi/skills/alpha/SKILL.md",
      content: frontMatterContent,
    });
    await waitFor(() => expect(contentSpy).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Steps")).toBeNull();
  });
});
