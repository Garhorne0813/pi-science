import { matchPath } from "react-router-dom";

/** Return a session only when the current page is the conversation itself. */
export function conversationSessionId(pathname: string): string | undefined {
  return matchPath({ path: "/workspace/:cwd/session/:sessionId", end: true }, pathname)?.params.sessionId;
}
