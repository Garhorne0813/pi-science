export class AgentRuntimeExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeExitedError";
  }
}

export class AgentRuntimeTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`agent runtime ${command} timed out after ${timeoutMs}ms`);
    this.name = "AgentRuntimeTimeoutError";
  }
}
