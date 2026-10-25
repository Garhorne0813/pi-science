import type { PiConfig, SessionStats } from "@pi-science/contracts";
import type { AgentCoreRuntimeClient } from "../agent-runtime-client.js";

export type Live = { key: string; runtime: AgentCoreRuntimeClient; busy: boolean; restartPending: boolean; model: string; thinking: string | null;
  config: PiConfig; eventSequence: number; expectedOperationId?: string; watchdog?: NodeJS.Timeout; suppressRecovery?: boolean;
  approvalTransitionFailed?: boolean;
  lastProgressAt: number; interactionWaitStartedAt?: number;
};

export type ProductHooks = {
  observe?: (cwd: string, sessionId: string, event: Record<string, unknown>) => void;
  settled?: (cwd: string, sessionId: string, turnId: string) => void;
  stats?: (cwd: string, sessionId: string, stats: SessionStats) => Promise<SessionStats>;
};

export type SessionServerOptions = { backendUrl?: string; internalToken?: string; onWorkerExit?: (cwd: string, sessionId: string) => Promise<void>; hasApprovalResources?: (cwd: string, sessionId: string) => boolean; revokeApprovalResources?: (cwd: string, sessionId: string) => Promise<{ kernelRestartCount: number }> };
