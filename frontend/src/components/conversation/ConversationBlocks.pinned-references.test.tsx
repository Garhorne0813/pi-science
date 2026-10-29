import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderBlocks } from "./ConversationBlocks";
import i18n from "../../i18n";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import type { AgentMessageBlock, ThreadBlock, TurnArtifactSummaryBlock } from "../../types/thread";
import { useUiStore } from "../../lib/ui";

const codeRunner: CodeRunner = { cwd: "proj", sessionId: "s1" };
const PATH = "figures/plot.png";
const V1_SHA = "a".repeat(64);
const V2_SHA = "b".repeat(64);

const user = (id: string, turnId: string): ThreadBlock => ({ kind: "user", id, turnId, text: id });
const agent = (id: string, turnId: string, text: string): AgentMessageBlock => ({ kind: "agent", id, turnId, parts: [{ id: `${id}-p0`, text }] });
const summary = (turnId: string, results: Array<{ path: string; version: number; sha256: string }>): TurnArtifactSummaryBlock => ({
  kind: "artifact-summary",
  id: `turn-artifacts-${turnId}`,
  turnId,
  artifacts: results.map((result) => ({ path: result.path, kind: "figure", mime: "image/png", size: 1, artifactId: `art-${result.path}`, version: result.version, sha256: result.sha256 })),
});

/** Both turns publish the same path, so a click that follows the newest version
 *  would silently open v2 from a message that referenced v1. */
function twoTurnsSharingOnePath(): ThreadBlock[] {
  return [
    user("u1", "t1"),
    agent("a1", "t1", "See [first plot](figures/plot.png)."),
    summary("t1", [{ path: PATH, version: 1, sha256: V1_SHA }]),
    user("u2", "t2"),
    agent("a2", "t2", "See [second plot](figures/plot.png)."),
    summary("t2", [{ path: PATH, version: 2, sha256: V2_SHA }]),
  ];
}

/** Stands in for GET /api/artifacts/by-path/*: answers the requested version,
 *  or the newest published one when the caller named none. */
function stubPublishedVersions(versions: Array<{ version: number; sha256: string }>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const query = /\/api\/artifacts\/by-path\/[^?]+\?(.*)$/.exec(url)?.[1];
    if (!query) return new Response(JSON.stringify({ error: "Not a by-path request" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const requested = new URLSearchParams(query).get("version");
    const row = requested ? versions.find((entry) => entry.version === Number(requested)) : versions.at(-1);
    return row
      ? new Response(JSON.stringify({ artifact_id: `art-${PATH}`, version: row.version, path: PATH, kind: "figure", mime: "image/png", size: 1, sha256: row.sha256, published_at: "" }), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify({ error: "Artifact version not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { useUiStore.setState({ inspectorOpen: false, inspectorData: null }); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUiStore.setState({ inspectorOpen: false, inspectorData: null });
});

describe("message references keep their own turn's published version", () => {
  it("reopens the first turn's v1 after the same path was published twice", async () => {
    const calls = stubPublishedVersions([{ version: 1, sha256: V1_SHA }, { version: 2, sha256: V2_SHA }]);
    render(<>{renderBlocks(twoTurnsSharingOnePath(), codeRunner)}</>);

    fireEvent.click(screen.getByRole("link", { name: "first plot" }));

    await waitFor(() => expect(useUiStore.getState().inspectorData).toMatchObject({ sha256: V1_SHA }));
    expect(useUiStore.getState().inspectorData).toMatchObject({ version: 1, versionSource: "pinned" });
    expect(calls.filter((url) => url.includes("/api/artifacts/by-path/")).at(-1)).toContain("version=1");
  });

  it("reopens the second turn's v2 from the second turn's own message", async () => {
    stubPublishedVersions([{ version: 1, sha256: V1_SHA }, { version: 2, sha256: V2_SHA }]);
    render(<>{renderBlocks(twoTurnsSharingOnePath(), codeRunner)}</>);

    fireEvent.click(screen.getByRole("link", { name: "second plot" }));

    await waitFor(() => expect(useUiStore.getState().inspectorData).toMatchObject({ sha256: V2_SHA }));
    expect(useUiStore.getState().inspectorData).toMatchObject({ version: 2, versionSource: "pinned" });
  });

  it("labels a reference its own turn never published as the latest published version", async () => {
    stubPublishedVersions([{ version: 1, sha256: V1_SHA }, { version: 2, sha256: V2_SHA }]);
    render(<>{renderBlocks([
      user("u1", "t1"),
      agent("a1", "t1", "See [unrelated plot](figures/plot.png)."),
      summary("t1", [{ path: "figures/other.png", version: 1, sha256: V1_SHA }]),
    ], codeRunner)}</>);

    fireEvent.click(screen.getByRole("link", { name: "unrelated plot" }));

    await waitFor(() => expect(useUiStore.getState().inspectorData).toMatchObject({ sha256: V2_SHA }));
    expect(useUiStore.getState().inspectorData).toMatchObject({ versionSource: "latest" });
  });
});
