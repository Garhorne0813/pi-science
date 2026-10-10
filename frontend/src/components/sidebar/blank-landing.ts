type LandingIntent = { kind: "explicit-new" | "active-session-deleted"; cwd: string };
type BlankLandingState = { landingIntent: LandingIntent; initialDraft?: string };
export function explicitNewLandingState(cwd: string, initialDraft?: string): BlankLandingState { return { landingIntent: { kind: "explicit-new", cwd }, ...(initialDraft !== undefined ? { initialDraft } : {}) }; }
export function deletedSessionLandingState(cwd: string): BlankLandingState { return { landingIntent: { kind: "active-session-deleted", cwd } }; }
export function blocksRootAutoNavigation(state: unknown, cwd: string): boolean {
  if (!state || typeof state !== "object" || !("landingIntent" in state)) return false;
  const intent = state.landingIntent;
  return !!intent && typeof intent === "object" && "kind" in intent && "cwd" in intent && intent.cwd === cwd && (intent.kind === "explicit-new" || intent.kind === "active-session-deleted");
}
