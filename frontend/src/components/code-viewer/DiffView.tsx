import { cn } from "@/lib/ui";

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
  const lines = text.split("\n");
  return (
    <pre className={cn("whitespace-pre-wrap font-mono text-xs text-muted", props.className)}>
      {lines.map((line, index) => (
        <span key={index} className={cn(
          !line.startsWith("+++ ") && line.startsWith("+") && "text-ok-text",
          !line.startsWith("--- ") && line.startsWith("-") && "text-error-text",
        )}>{line}{index < lines.length - 1 ? "\n" : ""}</span>
      ))}
    </pre>
  );
}
