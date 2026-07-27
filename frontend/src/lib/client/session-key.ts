/** Build a composite cache key that uniquely identifies a session within
 *  a specific workspace. Session names, the message cache and the SSE resume
 *  cursors all key on (cwd, sessionId) because different workspaces can have
 *  sessions with the same ID. */
export function sessionKey(cwd: string, sessionId: string): string {
  return `${cwd}\0${sessionId}`;
}
