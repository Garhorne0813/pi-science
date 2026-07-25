import { ConversationEventHub } from "./conversation-event-hub.js";
import { NodeSessionService } from "./node-session-service.js";
import { PiManager } from "./pi-manager.js";
import { SessionRepository } from "./session-repository.js";
import { SettingsStore } from "./settings-store.js";
import { JobCoordinator } from "./job-coordinator.js";

export interface ServerModules {
  readonly sessions: NodeSessionService;
  readonly events: ConversationEventHub;
  readonly sessionRepository: SessionRepository;
  readonly piManager: PiManager;
  readonly settings: SettingsStore;
  readonly jobs: JobCoordinator;
}

/** Creates an app-owned module graph. No mutable runtime state is shared across apps. */
export function createServerModules(): ServerModules {
  const events = new ConversationEventHub();
  const sessionRepository = new SessionRepository();
  const piManager = new PiManager();
  const sessions = new NodeSessionService(events, piManager, sessionRepository);
  const settings = new SettingsStore();
  const jobs = new JobCoordinator();
  return { sessions, events, sessionRepository, piManager, settings, jobs };
}
