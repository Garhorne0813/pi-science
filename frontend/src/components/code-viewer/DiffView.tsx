export function DiffView({ original, modified }: { original: string; modified: string }) {
  return <pre className="text-xs font-mono text-muted">{modified}</pre>;
}
