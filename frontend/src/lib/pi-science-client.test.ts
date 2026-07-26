/** Entry-level coverage: REST responses that carry session replacements reach
 *  the runtime store through the client's public surface. The client's own
 *  units are covered in ./client/*.test.ts. */

import { describe, expect, it } from "vitest";

import { installClientTestEnvironment } from "./client/test-helpers";
import { readSettingsResponse } from "./settings-api";
import { useRuntimeStore } from "./runtime-store";


installClientTestEnvironment();


describe("settings response handling", () => {
  it("accepts successful JSON responses", async () => {
    await expect(readSettingsResponse<{ ok: boolean }>(new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }), "fallback")).resolves.toEqual({ ok: true });
  });

  it("uses the backend error field before detail or fallback", async () => {
    await expect(readSettingsResponse(new Response(JSON.stringify({
      error: "custom provider could not be saved",
      detail: "less specific detail",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }), "fallback")).rejects.toThrow("custom provider could not be saved");
  });

  it("supports detail and fallback errors for compatibility responses", async () => {
    await expect(readSettingsResponse(new Response('{"detail":"invalid provider URL"}', {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }), "fallback")).rejects.toThrow("invalid provider URL");

    await expect(readSettingsResponse(new Response("not json", { status: 502 }), "settings unavailable"))
      .rejects.toThrow("settings unavailable");
  });

  it("applies REST session replacements from successful settings responses", async () => {
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: null,
      sessions: [{ id: "old", cwd: "/workspace", name: "Named conversation" }],
    });

    await readSettingsResponse(new Response(JSON.stringify({
      ok: true,
      session_replacements: [{ cwd: "/workspace", oldId: "old", newId: "new" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }), "fallback");

    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "new", name: "Named conversation" }),
    );
  });
});
