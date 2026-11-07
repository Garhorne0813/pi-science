import { presentToolActivity } from "../../../lib/conversation/activity-presenters";
import { toolDetails } from "./ToolDetails";
import type { ActivityRenderer } from "./types";

export const GenericActivityRenderer: ActivityRenderer = {
  compact: ({ source, t }) => ({ title: presentToolActivity(source, t) }),
  expanded: toolDetails,
};
