import type { DeliveryPolicy, LiteratureProvider, ScheduledSchedule } from "../../lib/scheduled-tasks";

export type ScheduledTaskKind = "literature_monitor" | "project_summary" | "reminder" | "data_monitor" | "analysis_run";

export interface ScheduledTaskProposal {
  proposal_id: string;
  title: string;
  task_kind: ScheduledTaskKind;
  description: string;
  schedule: { display_text: string; canonical: ScheduledSchedule };
  action_summary: string;
  delivery_policy: DeliveryPolicy;
  query: string;
  providers: LiteratureProvider[];
  focus?: string;
}

const providerLabels: Array<[LiteratureProvider, RegExp]> = [
  ["pubmed", /pubmed/i],
  ["arxiv", /arxiv/i],
  ["genbank", /genbank/i],
  ["pubchem", /pubchem/i],
  ["uniprot", /uniprot/i],
];

/** A bounded local interpreter for the Scheduled page. Chat creation still uses
 * the agent skill; this parser gives the management page an immediate proposal
 * without persisting any proposal state. The card makes every assumption visible. */
export function interpretScheduledTask(text: string, timezone: string, now = new Date()): ScheduledTaskProposal {
  const source = text.trim();
  const providers = providerLabels.filter(([, pattern]) => pattern.test(source)).map(([provider]) => provider);
  const selectedProviders: LiteratureProvider[] = providers.length > 0 ? providers : ["pubmed"];
  const timeMatch = source.match(/(?:上午|早上|下午|晚上)?\s*(\d{1,2})(?:[:：点时](\d{2})?)?/i) ?? source.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)\b/i);
  let hour = timeMatch ? Number(timeMatch[1]) : 9;
  const minute = timeMatch?.[2] ? Number(timeMatch[2]) : 0;
  if (/下午|晚上|\bpm\b/i.test(source) && hour < 12) hour += 12;
  if (/上午|早上|\bam\b/i.test(source) && hour === 12) hour = 0;
  const clock = `${String(Math.min(23, hour)).padStart(2, "0")}:${String(Math.min(59, minute)).padStart(2, "0")}`;

  let schedule: ScheduledSchedule;
  let display: string;
  if (/下周|tomorrow|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|提醒我|remind me/i.test(source) && !/每天|每日|every day|weekly|每周/i.test(source)) {
    const at = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    at.setHours(hour, minute, 0, 0);
    schedule = { type: "once", at: at.toISOString(), timezone };
    display = `Once · ${at.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  } else if (/工作日|weekday/i.test(source)) {
    schedule = { type: "cron", expression: `${minute} ${hour} * * 1-5`, timezone };
    display = `Every weekday · ${clock}`;
  } else if (/每周|weekly|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(source)) {
    const day = /周一|monday/i.test(source) ? 1 : /周二|tuesday/i.test(source) ? 2 : /周三|wednesday/i.test(source) ? 3 : /周四|thursday/i.test(source) ? 4 : /周六|saturday/i.test(source) ? 6 : /周日|sunday/i.test(source) ? 0 : 5;
    schedule = { type: "cron", expression: `${minute} ${hour} * * ${day}`, timezone };
    display = `Every week · ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]} ${clock}`;
  } else {
    schedule = { type: "cron", expression: `${minute} ${hour} * * *`, timezone };
    display = `Every day · ${clock}`;
  }

  const deliveryPolicy: DeliveryPolicy = /失败|failure|fails?/i.test(source)
    ? "only_on_failure"
    : /变化|更新时|on change|when .*changes?/i.test(source)
      ? "only_on_change"
      : /不用通知|重要|meaningful|relevant|only tell|只.*告诉/i.test(source)
        ? "only_when_relevant"
        : "always";
  const topic = source
    .replace(/每天|每日|工作日|每周|every day|every weekday|weekly/gi, " ")
    .replace(/上午|早上|下午|晚上|\b(?:at|am|pm)\b/gi, " ")
    .replace(/\d{1,2}(?::|点|时|：)?\d{0,2}/g, " ")
    .replace(/看看|检查|追踪|monitor|check|track|有没有|新的|new/gi, " ")
    .replace(/pubmed|arxiv|genbank|pubchem|uniprot/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || "research literature";
  const title = topic.length > 60 ? `${topic.slice(0, 57)}…` : topic;
  const taskKind: ScheduledTaskKind = /提醒|remind/i.test(source)
    ? "reminder"
    : /项目|project.*summar|summar.*project|weekly summar/i.test(source)
      ? "project_summary"
      : /数据集|dataset|data update/i.test(source)
        ? "data_monitor"
        : /分析|analysis/i.test(source) && !/paper|论文|文献|pubmed|arxiv/i.test(source)
          ? "analysis_run"
          : "literature_monitor";
  return {
    proposal_id: `proposal_${Date.now().toString(36)}`,
    title,
    task_kind: taskKind,
    description: source,
    schedule: { display_text: `${display} · ${timezone}`, canonical: schedule },
    action_summary: `Track ${topic} across ${selectedProviders.join(" + ")}`,
    delivery_policy: deliveryPolicy,
    query: topic,
    providers: selectedProviders,
  };
}

export function humanSchedule(schedule: ScheduledSchedule): string {
  if (schedule.type === "once") return `Once · ${new Date(schedule.at).toLocaleString()} · ${schedule.timezone}`;
  if (schedule.type === "interval") {
    const hours = schedule.every_seconds / 3600;
    return hours >= 24 && Number.isInteger(hours / 24) ? `Every ${hours / 24} day${hours === 24 ? "" : "s"} · ${schedule.timezone}` : `Every ${hours} hour${hours === 1 ? "" : "s"} · ${schedule.timezone}`;
  }
  const match = schedule.expression.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+(.+)$/);
  if (!match) return `Custom schedule · ${schedule.timezone}`;
  const clock = `${match[2]!.padStart(2, "0")}:${match[1]!.padStart(2, "0")}`;
  if (match[3] === "*") return `Every day · ${clock} · ${schedule.timezone}`;
  if (match[3] === "1-5") return `Every weekday · ${clock} · ${schedule.timezone}`;
  return `Weekly · ${clock} · ${schedule.timezone}`;
}

export function extractScheduledProposal(text: string): { text: string; proposal: ScheduledTaskProposal | null } {
  const pattern = /```scheduled-task-proposal\s*\n([\s\S]*?)```/i;
  const match = text.match(pattern);
  if (!match) return { text, proposal: null };
  try {
    const candidate = JSON.parse(match[1]!) as Partial<ScheduledTaskProposal>;
    const canonical = candidate.schedule?.canonical;
    const validSchedule = canonical?.type === "once" || canonical?.type === "interval" || canonical?.type === "cron";
    if (!candidate.title || !candidate.query || !candidate.action_summary || !candidate.schedule?.display_text || !validSchedule || !candidate.delivery_policy || !Array.isArray(candidate.providers) || candidate.providers.length === 0) {
      return { text, proposal: null };
    }
    return { text: text.replace(match[0], "").trim(), proposal: { ...candidate, proposal_id: candidate.proposal_id || `proposal_${Date.now().toString(36)}` } as ScheduledTaskProposal };
  } catch {
    return { text, proposal: null };
  }
}

export function deliveryLabel(policy: DeliveryPolicy): string {
  if (policy === "always") return "Every completed run";
  if (policy === "only_on_change") return "Only when something changes";
  if (policy === "only_on_failure") return "Only when a run fails";
  return "Only when meaningful results are found";
}
