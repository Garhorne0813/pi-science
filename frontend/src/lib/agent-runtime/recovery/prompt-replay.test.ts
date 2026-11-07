import { beforeEach, describe, expect, it, vi } from "vitest";
import { pendingPromptRequests, promptContentDigest, saveLocalPromptRequest } from "../../client/prompt-request-cache";
import { installClientTestEnvironment } from "../../client/test-helpers";
import type { GetState } from "../actions/types";
import { replayPendingPrompts, resetPendingPromptReplayForTest } from "./prompt-replay";

installClientTestEnvironment();

const CWD = "/workspace-a";
const CLIENT_MESSAGE_ID = "8fd824aa-51d3-4f63-839c-09e021b7970b";
const TEXT = "replay me after the refresh";

function pendingRecord(overrides: { sessionId?: string; createdAt?: number; text?: string } = {}) {
  const text = overrides.text ?? TEXT;
  return {
    cwd: CWD,
    sessionId: overrides.sessionId ?? "",
    clientMessageId: CLIENT_MESSAGE_ID,
    contentDigest: promptContentDigest(text),
    text,
    createdAt: overrides.createdAt ?? Date.now(),
    status: "pending" as const,
  };
}

function fakeStore(initial: { activeSessionId?: string | null; working?: boolean } = {}) {
  const state = {
    cwd: CWD,
    activeSessionId: initial.activeSessionId ?? null,
    working: initial.working ?? false,
    connect: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => {
      state.activeSessionId = "session-created";
      return "session-created" as string | null;
    }),
  };
  return { state, get: (() => state) as unknown as GetState };
}

beforeEach(() => {
  resetPendingPromptReplayForTest();
});

describe("pending prompt replay", () => {
  it("replays a stranded prompt exactly once when the landing effect runs twice", async () => {
    saveLocalPromptRequest(pendingRecord());
    const { get, state } = fakeStore();

    const [first, second] = await Promise.all([
      replayPendingPrompts(CWD, get),
      replayPendingPrompts(CWD, get),
    ]);

    expect(state.sendPrompt).toHaveBeenCalledTimes(1);
    expect(state.sendPrompt).toHaveBeenCalledWith(TEXT, CLIENT_MESSAGE_ID, { replay: true });
    expect([first, second].filter(Boolean)).toEqual(["session-created"]);
  });

  it("does nothing when no prompt was left behind", async () => {
    const { get, state } = fakeStore();
    await expect(replayPendingPrompts(CWD, get)).resolves.toBeNull();
    expect(state.sendPrompt).not.toHaveBeenCalled();
  });

  it("adopts the session the create round trip already produced", async () => {
    saveLocalPromptRequest(pendingRecord({ sessionId: "session-existing" }));
    const { get, state } = fakeStore();

    await replayPendingPrompts(CWD, get);

    expect(state.connect).toHaveBeenCalledWith(CWD, "session-existing");
    expect(state.sendPrompt).toHaveBeenCalledWith(TEXT, CLIENT_MESSAGE_ID, { replay: true });
  });

  it("keeps the record when the replay fails, so the next landing retries it", async () => {
    saveLocalPromptRequest(pendingRecord());
    const { get, state } = fakeStore();
    state.sendPrompt.mockRejectedValueOnce(new Error("backend down"));

    await expect(replayPendingPrompts(CWD, get)).resolves.toBeNull();
    expect(pendingPromptRequests(CWD)).toHaveLength(1);
  });

  it("does not replay a prompt the user typed hours ago", async () => {
    saveLocalPromptRequest(pendingRecord({ createdAt: Date.now() - 7 * 60 * 60 * 1000 }));
    const { get, state } = fakeStore();

    await expect(replayPendingPrompts(CWD, get)).resolves.toBeNull();
    expect(state.sendPrompt).not.toHaveBeenCalled();
  });

  it("never replays while another conversation is active", async () => {
    saveLocalPromptRequest(pendingRecord());
    const { get, state } = fakeStore({ activeSessionId: "session-other" });

    await expect(replayPendingPrompts(CWD, get)).resolves.toBeNull();
    expect(state.sendPrompt).not.toHaveBeenCalled();
  });
});
