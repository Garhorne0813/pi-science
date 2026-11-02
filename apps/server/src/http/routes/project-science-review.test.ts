import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerProjectRoutes } from "./project-routes.js";
import type { MemoryService } from "../../memory/service.js";
import type { MemoryBackground } from "../../memory/background.js";

it("validates and queues the science review for the requested session", async () => {
  const app = Fastify();
  const context = { ownerId: "owner", projectId: "project", actor: "user" as const, sessionId: "session" };
  const memory = { context: vi.fn(async () => ({ cwd: "/workspace", context })) };
  const background = { enqueue: vi.fn(async () => ({ id: "run", status: "queued" })) };
  registerProjectRoutes(app, memory as unknown as MemoryService, background as unknown as MemoryBackground);
  try {
    const invalid = await app.inject({ method: "POST", url: "/api/project-knowledge/science-review", payload: { cwd: "/workspace" } });
    expect(invalid.statusCode).toBe(400);
    const noTurn = await app.inject({ method: "POST", url: "/api/project-knowledge/science-review", payload: { cwd: "/workspace", session_id: "session", trigger: "auto" } });
    expect(noTurn.statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url: "/api/project-knowledge/science-review", payload: { cwd: "/workspace", session_id: "session", trigger: "auto", turn_id: "turn" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "run", status: "queued" });
    expect(memory.context).toHaveBeenCalledWith("/workspace", "user", "session");
    expect(background.enqueue).toHaveBeenCalledWith(context, "/workspace", "extraction", { sessionId: "session", automatic: true, scienceReview: true, turnId: "turn" });
  } finally { await app.close(); }
});
