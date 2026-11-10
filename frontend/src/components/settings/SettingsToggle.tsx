export function SettingsToggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className="inline-flex min-h-9 min-w-11 cursor-pointer items-center justify-end has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
    <span className="relative inline-flex h-5 w-9 shrink-0 rounded-full border border-border bg-surface-2 transition-colors has-[:checked]:border-transparent has-[:checked]:bg-accent-fill">
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
      <span className="pointer-events-none absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-accent-fg shadow-sm transition-transform peer-checked:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-accent" />
    </span>
  </label>;
}
