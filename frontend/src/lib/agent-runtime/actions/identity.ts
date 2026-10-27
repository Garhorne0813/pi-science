

export function connectionKey(cwd: string, sessionId?: string): string { return `${cwd}\u0000${sessionId ?? ""}`; }
export function historyPageKey(cwd: string, sessionId: string, before: string): string { return `${connectionKey(cwd, sessionId)}\u0000${before}`; }
export function interactionResponseKey(cwd: string, sessionId: string, requestId: string): string { return `${connectionKey(cwd, sessionId)}\u0000${requestId}`; }
