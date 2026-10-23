import { workspaceFile, readJson, withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";

export type AgentSessionRegistration = {
  backend: "agent-core";
  state: "active" | "deleted";
  target: string;
  source?: string;
  migration?: "copied";
  purpose?: "conversation" | "subagent" | "research" | "review";
  parentSessionId?: string;
};
type Registry = { version: 1; sessions: Record<string, AgentSessionRegistration> };

/** Durable ownership outlives transcripts, including retained legacy backups. */
export class AgentSessionRegistry {
  private path(cwd: string): string { return workspaceFile(cwd, "agent-session-registry.json"); }

  async all(cwd: string): Promise<Record<string, AgentSessionRegistration>> {
    return (await readJson<Registry>(this.path(cwd), { version: 1, sessions: {} })).sessions;
  }

  async get(cwd: string, sessionId: string): Promise<AgentSessionRegistration | undefined> {
    const sessions = await this.all(cwd);
    return Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined;
  }

  async register(cwd: string, sessionId: string, target: string, source?: string,
    ownership?: Pick<AgentSessionRegistration, "purpose" | "parentSessionId">): Promise<void> {
    await this.update(cwd, sessionId, (previous) => {
      if (previous?.state === "deleted") throw new Error("cannot reopen a deleted agent session");
      return { ...previous, backend: "agent-core", state: "active", target,
        purpose: previous?.purpose ?? ownership?.purpose ?? "conversation", ...ownership,
        ...(source ? { source, migration: "copied" } : {}) };
    });
  }

  async markDeleted(cwd: string, sessionId: string, target: string): Promise<void> {
    await this.update(cwd, sessionId, (previous) => ({ ...previous, backend: "agent-core", state: "deleted", target }));
  }

  private async update(cwd: string, sessionId: string,
    change: (previous: AgentSessionRegistration | undefined) => AgentSessionRegistration): Promise<void> {
    const path = this.path(cwd);
    await withFileWriteLock(path, async () => {
      const registry = await readJson<Registry>(path, { version: 1, sessions: {} });
      registry.sessions = { ...registry.sessions, [sessionId]: change(Object.hasOwn(registry.sessions, sessionId) ? registry.sessions[sessionId] : undefined) };
      await writeJsonAtomic(path, registry);
    });
  }
}
