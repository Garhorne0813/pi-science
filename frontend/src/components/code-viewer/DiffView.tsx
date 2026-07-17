import { cn } from "@/lib/cn";

type DiffViewProps =
  | { diff: string; className?: string }
  | { original: string; modified: string; className?: string };

export function DiffView(props: DiffViewProps) {
  const text = "diff" in props
    ? props.diff
    : [
        "--- original",
        "+++ modified",
        ...props.original.split("\n").map((line) => `-${line}`),
        ...props.modified.split("\n").map((line) => `+${line}`),
      ].join("\n");
  return (
    <pre className={cn("whitespace-pre-wrap font-mono text-xs text-muted", props.className)}>
      {text}
    </pre>
  );
}
