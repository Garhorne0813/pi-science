/** Section wrapper shared by settings pages: a soft card with a hairline
 *  border and a compact header, keeping the settings surface quiet instead of
 *  stacking full-width dividers. */
export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-faint bg-surface-2/40">
      {title && (
        <header className="flex shrink-0 items-center justify-between gap-card border-b border-faint px-4 py-3">
          <h2 className="text-[13px] font-semibold tracking-tight text-text">{title}</h2>
        </header>
      )}
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}
