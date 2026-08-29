import { randomUUID } from "node:crypto";
import {
  autoResearchBudgetSchema,
  createAutoResearchSchema,
  type AutoResearchSnapshot,
  type ResearchCommit,
} from "@pi-science/contracts";
import type { ResearchCreatedPayload, ResearchGraphEvent, ResearchMutationPayload } from "./events.js";
import { ResearchGraphRepository } from "./repository.js";
import { reduceResearchGraph } from "./reducer.js";
import { validateAndProjectCommit } from "./validator.js";

const id = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export class ResearchGraphStore {
  repository(cwd: string) { return new ResearchGraphRepository(cwd); }

  async create(cwd: string, input: unknown): Promise<AutoResearchSnapshot> {
    const parsed = createAutoResearchSchema.parse(input);
    const repository = this.repository(cwd);
    return repository.locked(async (events) => {
      const researchId = id("research");
      const now = new Date().toISOString();
      const question = {
        node_id: id("node"),
        kind: "question" as const,
        question: parsed.objective,
        status: "ready" as const,
        priority: Number.MAX_SAFE_INTEGER,
        created_at: now,
        updated_at: now,
      };
      const payload: ResearchCreatedPayload = {
        project_id: parsed.project_id,
        origin_session_id: parsed.origin_session_id,
        origin_message_id: parsed.origin_message_id,
        title: parsed.title,
        objective: parsed.objective,
        constraints: parsed.constraints,
        budget: autoResearchBudgetSchema.parse(parsed.budget),
        target_metrics: parsed.target_metrics,
        question,
      };
      const event = await repository.appendUnlocked({
        research_id: researchId,
        revision: 0,
        type: "research.created",
        timestamp: now,
        producer: "user",
        payload,
      });
      return reduceResearchGraph([...events, event], researchId)!;
    });
  }

  async commit(cwd: string, input: unknown): Promise<{ snapshot: AutoResearchSnapshot; commit: ResearchCommit }> {
    const repository = this.repository(cwd);
    return repository.locked(async (events) => {
      const researchId = typeof input === "object" && input !== null ? String((input as Record<string, unknown>).research_id ?? "") : "";
      const snapshot = reduceResearchGraph(events, researchId);
      if (!snapshot) throw new Error("research not found");
      const { commit, mutation } = validateAndProjectCommit(snapshot, input);
      const event = await repository.appendUnlocked({
        research_id: researchId,
        revision: snapshot.revision + 1,
        type: "research.commit.accepted",
        timestamp: new Date().toISOString(),
        producer: "pi-research-supervisor",
        commit_id: id("commit"),
        payload: mutation,
      });
      return { snapshot: reduceResearchGraph([...events, event], researchId)!, commit };
    });
  }

  async mutate(
    cwd: string,
    researchId: string,
    type: ResearchGraphEvent["type"],
    payload: ResearchMutationPayload,
    options?: { producer?: string; operation_id?: string },
  ) {
    return this.repository(cwd).mutate(researchId, type, payload, options);
  }

  async update(
    cwd: string,
    researchId: string,
    type: ResearchGraphEvent["type"],
    build: (snapshot: AutoResearchSnapshot) => ResearchMutationPayload,
    options: { producer?: string; operation_id?: string } = {},
  ): Promise<AutoResearchSnapshot> {
    const repository = this.repository(cwd);
    return repository.locked(async (events) => {
      const current = reduceResearchGraph(events, researchId);
      if (!current) throw new Error("research not found");
      const event = await repository.appendUnlocked({
        research_id: researchId,
        revision: current.revision + 1,
        type,
        timestamp: new Date().toISOString(),
        producer: options.producer ?? "node-research-orchestrator",
        ...(options.operation_id ? { operation_id: options.operation_id } : {}),
        payload: build(current),
      });
      return reduceResearchGraph([...events, event], researchId)!;
    });
  }

  snapshot(cwd: string, researchId: string) { return this.repository(cwd).snapshot(researchId); }
  list(cwd: string) { return this.repository(cwd).list(); }
}
