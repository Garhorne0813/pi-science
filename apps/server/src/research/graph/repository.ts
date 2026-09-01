import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonLineUnlocked, metadataRoot, withFileWriteLock } from "../../storage/persistence.js";
import type { ResearchGraphEvent, ResearchMutationPayload } from "./events.js";
import { listResearchGraphs, reduceResearchGraph } from "./reducer.js";

export class ResearchGraphRepository {
  constructor(readonly cwd: string) {}

  path(): string { return join(metadataRoot(this.cwd), "research-graph-v1.jsonl"); }

  async events(): Promise<ResearchGraphEvent[]> {
    let raw: string;
    try { raw = await readFile(this.path(), "utf8"); } catch { return []; }
    return raw.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const event = JSON.parse(line) as ResearchGraphEvent;
        return event.schema_version === 1 && typeof event.research_id === "string" ? [event] : [];
      } catch { return []; }
    });
  }

  async list() { return listResearchGraphs(await this.events()); }
  async snapshot(researchId: string) { return reduceResearchGraph(await this.events(), researchId); }

  async locked<T>(operation: (events: ResearchGraphEvent[]) => Promise<T>): Promise<T> {
    return withFileWriteLock(this.path(), async () => operation(await this.events()));
  }

  async appendUnlocked(event: Omit<ResearchGraphEvent, "schema_version" | "event_id">): Promise<ResearchGraphEvent> {
    const record: ResearchGraphEvent = {
      schema_version: 1,
      event_id: `event-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      ...event,
    };
    await appendJsonLineUnlocked(this.path(), record as unknown as Record<string, unknown>);
    return record;
  }

  async mutate(
    researchId: string,
    type: ResearchGraphEvent["type"],
    payload: ResearchMutationPayload,
    options: { producer?: string; operation_id?: string } = {},
  ) {
    return this.locked(async (events) => {
      const current = reduceResearchGraph(events, researchId);
      if (!current) throw new Error("research not found");
      const event = await this.appendUnlocked({
        research_id: researchId,
        revision: current.revision + 1,
        type,
        timestamp: new Date().toISOString(),
        producer: options.producer ?? "node-research-orchestrator",
        ...(options.operation_id ? { operation_id: options.operation_id } : {}),
        payload,
      });
      return reduceResearchGraph([...events, event], researchId)!;
    });
  }
}
