/** Section wrapper shared by settings pages, using the same divider heading as the page header. */
export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section>
      {title && (
        <header className="flex shrink-0 items-end justify-between gap-card border-b border-faint pb-panel md:pb-4">
          <h2 className="text-ui-title font-medium tracking-tight text-text">{title}</h2>
        </header>
      )}
      {children}
    </section>
  );
}
