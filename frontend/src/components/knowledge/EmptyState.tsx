export function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted">{icon}</div>
      <h2 className="mt-4 font-serif text-lg text-text">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{text}</p>
    </div>
  );
}
