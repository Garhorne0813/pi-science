import { presentFailedToolActivity, presentToolActivity } from "../../../lib/conversation/activity-presenters";
import { fileChange, genericDetails, toolErrorSummary, toolFilePath } from "./shared";
import type { ActivityRenderer } from "./types";

export const FileActivityRenderer: ActivityRenderer = {
  compact: ({ source, t }) => {
    const change = fileChange(source);
    const path = toolFilePath(source);
    const failure = toolErrorSummary(source);
    return {
      title: source.status === "error" ? presentFailedToolActivity(source, t) : presentToolActivity(source, t),
      ...(failure ? { detail: failure } : path ? { detail: path } : {}),
      ...(change && (change.additions > 0 || change.deletions > 0)
        ? {
            fileChange: {
              path: change.path,
              additions: change.additions,
              deletions: change.deletions,
              ...(change.truncated ? { truncated: true } : {}),
            },
          }
        : {}),
    };
  },
  expanded: genericDetails,
};
