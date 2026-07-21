import { cn } from "../../lib/cn";

const starters = [
  { icon: "📊", label: "Analyze data", desc: "Load a CSV, NetCDF, or FITS file and find patterns.", prompt: "Analyze the dataset in this directory and give me key statistical insights." },
  { icon: "📝", label: "Write report", desc: "Generate a scientific report from the findings.", prompt: "Write a scientific report based on the data analysis results." },
  { icon: "🐍", label: "Run Python", desc: "Execute code in an interactive notebook session.", prompt: "Write and run a Python script to process the data files in this workspace." },
  { icon: "🔬", label: "Run experiment", desc: "Design and execute a computational experiment.", prompt: "Design an experiment to test the hypothesis and run the analysis." },
];

export function ConversationWelcome({ onPick, disabled = false }: { onPick: (message: string) => void; disabled?: boolean }) {
  return (
    <div className="min-h-[62vh] flex flex-col items-center justify-center">
      <div className="max-w-[500px]">
        <p className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-muted">Scientific AI Workbench</p>
        <h2 className="mt-1.5 font-serif text-[26px] leading-tight text-text">Pi-Science</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">Powered by the pi agent runtime. Analyze data, run code, and explore results with AI assistance.</p>
      </div>
      <div className="mt-7 w-full max-w-[500px] rounded-card border border-border bg-surface shadow-card">
        {starters.map((starter, index) => (
          <button key={starter.label} type="button" onClick={() => onPick(starter.prompt)} disabled={disabled} className={cn("group flex w-full items-center gap-3.5 px-4 py-3.5 text-left disabled:cursor-wait disabled:opacity-50", !disabled && "hover:bg-surface-2", index > 0 && "border-t border-border", index === 0 && "rounded-t-card", index === starters.length - 1 && "rounded-b-card")}>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-lg text-accent ring-1 ring-border">{starter.icon}</span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-medium text-text">{starter.label}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted">{starter.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
