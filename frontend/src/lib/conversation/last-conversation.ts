const storageKey = (cwd: string) => `pi-science.last-conversation.${encodeURIComponent(cwd)}`;

export function rememberLastConversation(cwd: string, sessionId: string) {
  try { localStorage.setItem(storageKey(cwd), sessionId); } catch { /* storage can be unavailable */ }
}

export function readLastConversation(cwd: string): string | null {
  try { return localStorage.getItem(storageKey(cwd)); } catch { return null; }
}
