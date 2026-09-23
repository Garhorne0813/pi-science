import { presentToolActivity } from "../../../lib/conversation/activity-presenters";
import { genericDetails } from "./shared";
import type { ActivityRenderer } from "./types";

export const GenericActivityRenderer: ActivityRenderer = {
  compact: ({ source, t }) => ({ title: presentToolActivity(source, t) }),
  expanded: genericDetails,
};
