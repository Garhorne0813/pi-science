import { describe, expect, it } from "vitest";
import { stripCwdPrefix, toWorkspaceRelativePath } from "./workspace-path";

describe("workspace path mapping", () => {
  const cwd = "/home/caee/pi-science-workspaces/rosavin";

  it("strips the cwd prefix for paths under the workspace", () => {
    expect(toWorkspaceRelativePath(`${cwd}/figures/plot.png`, cwd)).toBe("figures/plot.png");
    expect(toWorkspaceRelativePath(`${cwd}/pelican_bike.svg`, cwd)).toBe("pelican_bike.svg");
  });

  it("treats an absolute path outside cwd as the workspace-root shorthand", () => {
    expect(toWorkspaceRelativePath("/figures/a.png", cwd)).toBe("figures/a.png");
    expect(toWorkspaceRelativePath("/tmp/other/plot.png", cwd)).toBe("tmp/other/plot.png");
  });

  it("normalizes dot segments and refuses to climb out of the workspace", () => {
    expect(toWorkspaceRelativePath(`${cwd}/figures/../a.png`, cwd)).toBe("a.png");
    expect(toWorkspaceRelativePath(`${cwd}/figures/../../etc/passwd.txt`, cwd)).toBeNull();
    expect(toWorkspaceRelativePath("/../../secret.txt", cwd)).toBeNull();
  });

  it("handles Windows drive paths with a case-insensitive drive", () => {
    expect(toWorkspaceRelativePath("C:\\Users\\cyq\\ws\\figures\\a.png", "c:/Users/cyq/ws")).toBe("figures/a.png");
    expect(toWorkspaceRelativePath("c:/Users/cyq/ws/figures/a.png", "C:/Users/cyq/ws")).toBe("figures/a.png");
    expect(toWorkspaceRelativePath("C:\\figures\\a.png", "C:\\Users\\cyq\\ws")).toBe("figures/a.png");
  });

  it("passes relative spellings through and tolerates a missing cwd", () => {
    expect(toWorkspaceRelativePath("work/plot.png", cwd)).toBe("work/plot.png");
    expect(toWorkspaceRelativePath("./work/plot.png", cwd)).toBe("work/plot.png");
    expect(toWorkspaceRelativePath("../outside.png", cwd)).toBe("../outside.png");
    expect(toWorkspaceRelativePath(`${cwd}/a.png`, "")).toBe(`${cwd}/a.png`);
    expect(toWorkspaceRelativePath("", cwd)).toBeNull();
  });

  it("leaves the cwd itself unnamed (it is a directory, not a file)", () => {
    expect(stripCwdPrefix(`${cwd}/figures`, cwd)).toBe("figures");
    expect(stripCwdPrefix(cwd, cwd)).toBeNull();
    expect(stripCwdPrefix("/home/other/figures", cwd)).toBeNull();
  });
});
