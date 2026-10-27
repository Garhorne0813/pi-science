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
    options?: ErrorOptions,
  ) {
    super(message, options);
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
// Automatic acceptance is a closed grammar of presentation preferences. Unknown
// wording (including scientific instructions disguised as preferences) is reviewed.
export function scientific(c: MemoryContent): boolean {
  if (!["preference", "workflow"].includes(c.kind)) return true;
  const title = c.title.trim().toLowerCase();
  const titles = new Set([
    "preference",
    "language preference",
    "reply language",
    "response language",
    "answer language",
    "reply style",
    "response style",
    "response format",
    "format preference",
    "theme preference",
    "ui theme",
    "语言偏好",
    "回复语言",
    "回答语言",
    "回复风格",
    "回复格式",
    "界面主题",
  ]);
  if (!titles.has(title)) return true;
  const body = c.body.trim().replace(/[。.!]$/, "");
  const english =
    /^(?:user prefers?|i prefer|prefer|please use|use|always use|default to) (?:chinese|simplified chinese|traditional chinese|english|(?:chinese|english) (?:replies|responses|answers)|(?:concise|brief|detailed) (?:replies|responses|answers|reply formatting)|(?:dark|light) (?:mode|theme)|(?:markdown|plain text)(?: (?:replies|responses|format))?|(?:bullet|numbered) lists)$/i;
  const chinese =
    /^(?:用户偏好|我偏好|请使用|默认使用|使用)(?:中文(?:回答|回复)?|简体中文|繁体中文|英文(?:回答|回复)?|英语|深色界面|浅色界面|(?:会话内)?简洁表达|简洁回复|详细回复|Markdown格式|纯文本回复|项目符号列表|编号列表)$/i;
  return !english.test(body) && !chinese.test(body);
}
