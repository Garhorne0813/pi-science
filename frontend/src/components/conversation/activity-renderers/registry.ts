import type { ActivityKind } from "../../../lib/conversation/projection";
import { GenericActivityRenderer } from "./GenericActivity";
import { KernelActivityRenderer } from "./KernelActivity";
import { LiteratureActivityRenderer } from "./LiteratureActivity";
import type { ActivityRenderer } from "./types";

export class ActivityRendererRegistry {
  private readonly renderers = new Map<string, ActivityRenderer>();
  private readonly fallback: ActivityRenderer;

  constructor(fallback: ActivityRenderer = GenericActivityRenderer) {
    this.fallback = fallback;
  }

  register(kind: ActivityKind | string, renderer: ActivityRenderer): this {
    this.renderers.set(kind, renderer);
    return this;
  }

  resolve(kind: ActivityKind | string | undefined): ActivityRenderer {
    return kind ? this.renderers.get(kind) ?? this.fallback : this.fallback;
  }
}

export const activityRendererRegistry = new ActivityRendererRegistry()
  .register("kernel", KernelActivityRenderer)
  .register("literature", LiteratureActivityRenderer);

export * from "./types";
