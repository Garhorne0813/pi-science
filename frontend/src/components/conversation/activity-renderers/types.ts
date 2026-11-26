import type { ActivityProjection } from "../../../lib/conversation/projection";
import type { ToolCallBlock } from "../../../types/thread";

export type ActivityTranslate = (key: string, values?: Record<string, unknown>) => string;

export interface ActivityRendererProps {
  activity: ActivityProjection;
  source: ToolCallBlock;
  live: boolean;
  t: ActivityTranslate;
}

export interface ActivityCompactView {
  title: string;
  detail?: string;
  fileChange?: {
    path: string;
    additions: number;
    deletions: number;
    truncated?: boolean;
  };
}

export interface ActivityDetailView {
  label: string;
  value: string;
  plain?: boolean;
  pre?: boolean;
  fullValue?: string;
  partial?: boolean;
  transportTruncated?: boolean;
  originalBytes?: number;
}

export interface ActivityRenderer {
  compact(props: ActivityRendererProps): ActivityCompactView;
  expanded(props: ActivityRendererProps): ActivityDetailView[];
}
