import { presentToolActivity } from "../../../lib/conversation/activity-presenters";
import { fileChange, genericDetails } from "./shared";
import type { ActivityRenderer } from "./types";

export const GenericActivityRenderer: ActivityRenderer = {
  compact: ({ source, t }) => {
    const change = fileChange(source);
    return {
      title: presentToolActivity(source, t),
      ...(change && (change.additions > 0 || change.deletions > 0)
        ? { fileChange: { additions: change.additions, deletions: change.deletions } }
        : {}),
    };
  },
  expanded: genericDetails,
};
