import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Play, RotateCcw, Terminal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OutputMessage, PatinaeViewer } from "@patinae/viewer";
import {
  initialPatinaeCommands,
  patinaeFormatFor,
  patinaeObjectName,
} from "@/lib/viewers/patinae";
import { looksLikeMacromolecule } from "@/lib/viewers/molecule";
import {
  registerActiveMoleculeViewer,
  type MoleculeViewerController,
} from "@/lib/viewers/molecule-controller";
import { cn } from "@/lib/cn";

const MAX_OUTPUT_MESSAGES = 100;
const MAX_COMMAND_HISTORY = 50;

type Props = {
  filename: string;
  text: string;
  onUnavailable?: (message: string) => void;
};

export function PatinaeMoleculeView({ filename, text, onUnavailable }: Props) {
  const { t } = useTranslation();
  const format = patinaeFormatFor(filename);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<PatinaeViewer | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  const [command, setCommand] = useState("");
  const [messages, setMessages] = useState<OutputMessage[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [atomCount, setAtomCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const format = patinaeFormatFor(filename);

    if (!container || !format) {
      const message = t("molecule.patinae.unsupportedFormat");
      setError(message);
      onUnavailableRef.current?.(message);
      return;
    }

    let disposed = false;
    let viewer: PatinaeViewer | null = null;
    let unregisterController: (() => void) | null = null;

    setInitializing(true);
    setError(null);
    setMessages([]);
    setAtomCount(null);
    container.replaceChildren();

    const appendMessage = (message: { level: string; text: string }) => {
      if (disposed) return;
      const level: OutputMessage["level"] =
        message.level === "error" || message.level === "warning" || message.level === "clear"
          ? message.level
          : "info";
      setMessages((current) => [
        ...current.slice(-(MAX_OUTPUT_MESSAGES - 1)),
        { level, text: message.text },
      ]);
    };

    const initialize = async () => {
      try {
        const module = await import("@patinae/viewer");
        if (disposed) return;

        viewer = new module.PatinaeViewer(container, {
          picking: false,
          selectionOverlay: false,
          memoryProfile: "balanced",
        });
        viewer.on("command-output", appendMessage);
        await viewer.init();

        if (disposed) {
          viewer.destroy();
          viewer = null;
          return;
        }

        const bytes = new TextEncoder().encode(text);
        viewer.loadData(bytes, patinaeObjectName(filename), format);
        for (const initialCommand of initialPatinaeCommands(looksLikeMacromolecule(text))) {
          viewer.execute(initialCommand);
        }

        viewerRef.current = viewer;
        const activeViewer = viewer;
        const controller: MoleculeViewerController = {
          id: `patinae:${patinaeObjectName(filename)}`,
          filename,
          execute: (value) => activeViewer.executeAsync(value),
        };
        unregisterController = registerActiveMoleculeViewer(controller);
        setAtomCount(activeViewer.countAtoms("all"));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const userMessage = t("molecule.patinae.initializeFailed", { message });
        setError(userMessage);
        onUnavailableRef.current?.(userMessage);
        unregisterController?.();
        unregisterController = null;
        viewerRef.current = null;
        viewer?.destroy();
        viewer = null;
      } finally {
        if (!disposed) setInitializing(false);
      }
    };

    void initialize();

    return () => {
      disposed = true;
      unregisterController?.();
      viewerRef.current = null;
      viewer?.destroy();
      viewer = null;
      container.replaceChildren();
    };
  }, [filename, t, text]);

  const executeCommand = useCallback(async () => {
    const viewer = viewerRef.current;
    const value = command.trim();
    if (!viewer || !value) return;

    historyRef.current = [
      value,
      ...historyRef.current.filter((item) => item !== value),
    ].slice(0, MAX_COMMAND_HISTORY);
    historyIndexRef.current = -1;
    setCommand("");

    try {
      await viewer.executeAsync(value);
      setAtomCount(viewer.countAtoms("all"));
    } catch (cause) {
      setMessages((current) => [
        ...current.slice(-(MAX_OUTPUT_MESSAGES - 1)),
        {
          level: "error",
          text: cause instanceof Error ? cause.message : String(cause),
        },
      ]);
    }
  }, [command]);

  const onCommandKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void executeCommand();
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();

      const history = historyRef.current;
      if (history.length === 0) return;
      if (event.key === "ArrowUp") {
        historyIndexRef.current = Math.min(historyIndexRef.current + 1, history.length - 1);
      } else {
        historyIndexRef.current = Math.max(historyIndexRef.current - 1, -1);
      }
      setCommand(historyIndexRef.current === -1 ? "" : history[historyIndexRef.current] ?? "");
    },
    [executeCommand],
  );

  const resetView = useCallback(() => {
    viewerRef.current?.execute("orient");
  }, []);

  return (
    <div className="flex h-full min-h-[420px] w-full flex-col overflow-hidden bg-black">
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="absolute inset-0"
          aria-label={t("molecule.patinae.viewerLabel")}
        />

        <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-input border border-white/15 bg-black/65 p-1 shadow-card backdrop-blur">
          <div className="flex items-center gap-1 px-1.5 text-xs font-medium text-white/75">
            <Terminal size={13} /> {t("molecule.viewer.patinae")}
          </div>
          <button
            type="button"
            onClick={resetView}
            disabled={!viewerRef.current}
            aria-label={t("molecule.resetView")}
            title={t("molecule.resetView")}
            className="flex h-7 w-7 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
          >
            <RotateCcw size={13} />
          </button>
        </div>

        <div className="pointer-events-none absolute bottom-3 right-3 rounded-input border border-white/15 bg-black/65 px-3 py-1.5 text-xs text-white/70 shadow-card backdrop-blur">
          <span className="font-medium text-white">{(format ?? "").toUpperCase()}</span>
          {atomCount !== null && <span className="ml-2">{t("molecule.atomCount", { count: atomCount })}</span>}
        </div>

        {(initializing || error) && (
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[75%] rounded-input border border-white/15 bg-black/75 px-3 py-1.5 text-xs text-white/75 shadow-card backdrop-blur">
            {initializing ? t("molecule.patinae.initializing") : error}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-surface">
        {messages.length > 0 && (
          <div className="max-h-28 overflow-auto border-b border-border px-3 py-2 font-mono text-xs" aria-live="polite">
            {messages.map((message, index) => (
              <div
                key={`${index}-${message.level}-${message.text}`}
                className={cn(
                  "whitespace-pre-wrap",
                  message.level === "error" && "text-red-500",
                  message.level === "warning" && "text-amber-500",
                  message.level !== "error" && message.level !== "warning" && "text-muted",
                )}
              >
                {message.text}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 p-2">
          <label className="sr-only" htmlFor="patinae-command">
            {t("molecule.patinae.commandLabel")}
          </label>
          <input
            id="patinae-command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={onCommandKeyDown}
            disabled={!viewerRef.current}
            placeholder={t("molecule.patinae.commandPlaceholder")}
            aria-label={t("molecule.patinae.commandLabel")}
            className="min-h-9 min-w-0 flex-1 rounded-input border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text outline-none transition-colors placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void executeCommand()}
            disabled={!viewerRef.current || !command.trim()}
            className="flex min-h-9 items-center gap-1 rounded-input bg-accent px-3 text-sm font-medium text-white transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play size={14} />
            {t("molecule.patinae.runCommand")}
          </button>
          <button
            type="button"
            onClick={() => setMessages([])}
            disabled={messages.length === 0}
            aria-label={t("molecule.patinae.clearOutput")}
            title={t("molecule.patinae.clearOutput")}
            className="flex h-9 w-9 items-center justify-center rounded-input border border-border text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
