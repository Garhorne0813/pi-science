import { useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import type { ArtifactInspector as ArtifactInspectorT, ArtifactTab } from "../../types/thread";
import { useScrollMemory } from "@/lib/scrollMemory";
import { cn } from "@/lib/cn";
import { CodeViewer } from "@/components/code-viewer/CodeViewer";
import { PaneTitlebarInset } from "./RightPane";
import { resolveArtifactContent } from "@/lib/artifacts";
import { saveTextWithFeedback } from "@/lib/download";

const TABS: Array<{ id: ArtifactTab; label: string }> = [
  { id: "code", label: "Code" },
  { id: "log", label: "Execution Log" },
  { id: "messages", label: "Messages" },
  { id: "environment", label: "Environment" },
  { id: "review", label: "Review" },
];

export function ArtifactInspector({
  data,
  onClose,
  controls,
}: {
  data: ArtifactInspectorT;
  onClose: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
}) {
  const [tab, setTab] = useState<ArtifactTab>("code");
  const [versionIdx, setVersionIdx] = useState(() =>
    Math.max(
      0,
      data.versions.findIndex(
        (version) => version.id === data.activeVersion || version.label === data.activeVersion,
      ),
    ),
  );

  const activeVersion = data.versions[versionIdx];
  const activeKey = activeVersion?.id ?? activeVersion?.label ?? data.activeVersion;
  const activeLabel = activeVersion?.label ?? activeVersion?.id ?? data.activeVersion;
  const content = resolveArtifactContent(data, activeKey);
  const scriptName = data.filename ?? data.title;

  const step = (delta: number) =>
    setVersionIdx((i) => Math.min(Math.max(0, data.versions.length - 1), Math.max(0, i + delta)));

  // Viewing position per artifact tab, restored when reopened.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(scrollRef, `artifact:${data.title}:${tab}`);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <span className="truncate text-sm font-medium text-text">{data.title}</span>
        <div className="ml-2 flex items-center gap-1 text-text">
          <button
            className="disabled:opacity-30 hover:opacity-60"
            aria-label="Previous version"
            onClick={() => step(-1)}
            disabled={versionIdx === 0}
          >
            <ChevronLeft size={14} strokeWidth={1.5} />
          </button>
          <span className="rounded bg-surface-2 px-1.5 text-xs text-muted">{activeLabel}</span>
          <button
            className="disabled:opacity-30 hover:opacity-60"
            aria-label="Next version"
            onClick={() => step(1)}
            disabled={versionIdx >= data.versions.length - 1}
          >
            <ChevronRight size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="flex-1" />
        <button
          className="text-text hover:opacity-60"
          aria-label="Download"
          onClick={() => void saveTextWithFeedback(scriptName, content.code)}
        >
          <Download size={14} strokeWidth={1.5} />
        </button>
        {controls}
        <button className="text-text hover:opacity-60" aria-label="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <nav className="flex items-center gap-4 border-b border-border px-4">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1 border-b-2 py-2.5 text-sm",
              tab === id
                ? "border-accent text-text"
                : "border-transparent text-muted hover:text-text",
            )}
          >
            {label}
            {id === "review" && content.reviewPassed && <Check size={13} className="text-ok" />}
          </button>
        ))}
      </nav>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-4">
        {tab === "code" && (
          <div className="space-y-3">
            <button
              className="flex items-center gap-2 rounded-input bg-link px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              onClick={() => void saveTextWithFeedback(scriptName, content.code)}
            >
              <Download size={15} /> {"Download script"}
            </button>
            {(data.inputs ?? []).length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{"Inputs"}</span>
                {(data.inputs ?? []).map((f) => (
                  <span
                    key={f}
                    className="rounded-input bg-surface-2 px-2 py-1 font-mono text-xs text-text ring-1 ring-border"
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}
            <CodeViewer code={content.code} language={data.language} startLine={data.codeStartLine} />
          </div>
        )}
        {tab === "log" && <Pre text={content.executionLog ?? "No execution log"} />}
        {tab === "messages" && (
          <ul className="space-y-2">
            {(content.messages ?? []).map((m, i) => (
              <li key={i} className="rounded-input bg-surface-2 px-3 py-2 text-sm text-text">
                {m}
              </li>
            ))}
            {(content.messages ?? []).length === 0 && (
              <li className="text-sm text-muted">{"No messages"}</li>
            )}
          </ul>
        )}
        {tab === "environment" && <Pre text={content.environment ?? "No environment info"} />}
        {tab === "review" &&
          (content.reviewPassed ? (
            <div className="flex items-center gap-2 text-sm text-ok">
              <Check size={16} /> {`Review passed (${activeLabel})`}
            </div>
          ) : (
            <div className="text-sm text-muted">{`Review not passed (${activeLabel})`}</div>
          ))}
      </div>
    </div>
  );
}

function Pre({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[12.5px] text-text">
      {text}
    </pre>
  );
}
