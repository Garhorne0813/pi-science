import { describe, expect, it, vi } from "vitest";

import { useRuntimeStore } from "./index";
import { installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";

installRuntimeTestEnvironment();

describe("late-stream final-answer recovery", () => {
  it("does not settle on intermediate commentary before the final answer arrives", async () => {
    let messageReads = 0;
    const beforePrompt = new Date(Date.now() - 60_000).toISOString();
    const afterPrompt = new Date(Date.now() + 60_000).toISOString();
    const intermediate = {
      id: "agent-commentary",
      role: "assistant",
      content: [{ type: "text", text: "I will search for that." }],
      timestamp: afterPrompt,
      presentationRole: "intermediate",
    };
    const final = {
      id: "agent-final",
      role: "assistant",
      content: [{ type: "text", text: "Final answer" }],
      timestamp: afterPrompt,
      presentationRole: "final",
    };

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        messageReads += 1;
        if (messageReads === 1) return jsonResponse({ messages: [] });
        const messages = [
          { id: "user-1", role: "user", content: [{ type: "text", text: "search" }], timestamp: beforePrompt },
          intermediate,
          ...(messageReads >= 3 ? [final] : []),
        ];
        return jsonResponse({ messages });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    await useRuntimeStore.getState().sendPrompt("search");

    // The first idle probe sees only explicit commentary. The turn must stay
    // live instead of flashing "Completed · No final answer returned".
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(useRuntimeStore.getState().working).toBe(true);
    expect(useRuntimeStore.getState().turnLifecycle).toBe("active");

    // The next probe sees an explicit final answer and may settle normally.
    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false), { timeout: 5_000 });
    await vi.waitFor(() => expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "agent-final", presentationRole: "final" }),
    ));
    expect(messageReads).toBeGreaterThanOrEqual(3);
  });
});
