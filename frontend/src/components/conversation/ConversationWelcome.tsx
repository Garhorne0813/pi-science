export function ConversationWelcome() {
  return (
    <div className="flex flex-col items-start text-left">
      <div className="max-w-[500px]">
        <p className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-muted">Scientific AI Workbench</p>
        <h2 className="mt-1.5 font-serif text-[26px] leading-tight text-text">Pi-Science</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">Powered by the pi agent runtime. Analyze data, run code, and explore results with AI assistance.</p>
      </div>
    </div>
  );
}
