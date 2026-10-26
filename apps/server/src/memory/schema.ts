import type { MemoryContent } from "@pi-science/contracts";
export {
  sourceSchema,
  contentSchema,
  settingsSchema,
  memoryBrowseQuerySchema,
} from "@pi-science/contracts";
export type {
  MemoryContent,
  MemoryContext,
  MemoryRecord,
  MemorySettings,
} from "@pi-science/contracts";
export class MemoryError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function tokens(text: string): string[] {
  const lower = text.toLowerCase();
  const words: string[] = lower.match(/[a-z0-9_./:-]+/g) ?? [];
  for (const match of lower.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...match[0]];
    words.push(...chars);
    for (let i = 0; i < chars.length - 1; i++)
      words.push(chars[i]! + chars[i + 1]!);
  }
  return [...new Set(words)];
}
export function scientific(c: MemoryContent): boolean {
  // Only explicit, narrowly scoped preference/workflow statements can bypass human review.
  // Semantic claims disguised as a low-risk kind therefore fail closed.
  if (!["preference", "workflow"].includes(c.kind)) return true;
  const text = c.title + " " + c.body;
  if (
    /实验|研究|结果|证明|显著|因果|模型|优于|假设|疗效|准确率|数据集|结论|证据|随机|异常值|样本|训练|统计|置信|概率|参数|误差|优化|剂量|分析|阈值|评估|experiment|significan|caus|hypothes|accuracy|outperform|model|dataset|evidence|result|finding|conclu|outlier|randomiz|sample|training|statistic|confidence|dosage|threshold|p-value/i.test(
      text,
    )
  )
    return true;
  if (
    !/语言|中文|英文|英语|简体|繁体|回答|回复|界面|深色|浅色|配色|段落|列表|命名|格式|缩进|编码|日期|日志|链接|标识|目录|文件名|路径|备份|简洁|表达|language|repl|response|theme|colou?r|format|style|naming|indent|encoding|time.?zone|date|log|link|identifier|backup|workflow summaries/i.test(
      text,
    )
  )
    return true;
  return !/^(?:我|用户|请|偏好|习惯|使用|始终|默认|工作|项目约定|prefer|user|please|always|use |default|workflow)/i.test(
    c.body,
  );
}
