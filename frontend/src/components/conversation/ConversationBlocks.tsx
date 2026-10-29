import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, File, FolderOpen } from "lucide-react";
import { cn } from "../../lib/ui";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import type { AgentMessageBlock, StatusLineBlock, ThreadBlock, UserMessageBlock } from "../../types/thread";
import { MarkdownViewer, type CodeRunner } from "../markdown-viewer/MarkdownViewer";
import { normalizeArtifactPath, pinnedFileInspector, pinnedReferenceMap } from "../../lib/artifacts";
import type { PublishedReference } from "../../lib/artifacts/artifact-versions";
import { ReferencedArtifactStrip, TurnArtifactStrip } from "./TurnArtifactStrip";
import { referencesFromMessage, visibleUserMessage } from "../../lib/files";
import { agentActionTextByBlock } from "../../lib/conversation";
import { extractCitations } from "../../lib/citations";
import { CitationChips } from "./CitationChips";
import { parseSuggestions } from "../../lib/conversation";
import { MessageActions, MessageSelectionQuoteMenu, type MessageSelectionAnchor } from "./MessageActions";
import { buildMessageQuote, selectedTextWithin, useMessageQuoteStore, type MessageQuoteScope, type MessageQuoteSource } from "../../lib/conversation/message-quote";
import { messageAnchorId, quotedMessagesFromMessage } from "../../lib/conversation/quoted-message";
import { buildTurnPresentations, turnBlockIds, type TurnPresentation } from "../../lib/conversation/turn-presentation";
import { AgentActivity } from "./AgentActivity";
import { isLiveLifecycle } from "../../lib/conversation/turn-presentation";

export function renderTurn(turn: TurnPresentation, codeRunner: CodeRunner, actionTextByBlock?: Map<string, string>) {
  return <ConversationTurn key={turn.id} turn={turn} codeRunner={codeRunner} actionTextByBlock={actionTextByBlock} />;
}

export function renderBlocks(blocks: ThreadBlock[], codeRunner: CodeRunner) {
  if (!Array.isArray(blocks)) return null;
  const actionTextByBlock = agentActionTextByBlock(blocks);
  return buildTurnPresentations(blocks).map((turn) => renderTurn(turn, codeRunner, actionTextByBlock));
}

function ConversationTurn({ turn, codeRunner, actionTextByBlock }: { turn: TurnPresentation; codeRunner: CodeRunner; actionTextByBlock?: Map<string, string> }) {
  const visibleAgent = turn.finalAgent ?? turn.provisionalAgent;
  const finalText = turn.finalAgent?.parts.map((part) => part.text).join("") ?? "";
  const publishedPaths = turn.artifacts.flatMap((block) => block.artifacts.map((item) => item.path));
  // References formed in this turn keep this turn's published versions, so a
  // reloaded history message reopens what it referenced, not what is newest now.
  const pinnedReferences = pinnedReferenceMap(turn.artifacts.flatMap((block) => block.artifacts));
  const scope: MessageQuoteScope = { workspaceCwd: codeRunner.cwd, sessionId: codeRunner.sessionId };
  // A settled turn with both boundaries can report its own duration even when
  // nothing folded into the process trace.
  const showActivity = turn.active
    || turn.lifecycle === "aborted" || turn.lifecycle === "failed"
    || turn.activityBlocks.length > 0
    || (turn.lifecycle === "settled" && Boolean(turn.user && turn.finalAgent));
  return (
    <div data-thread-block-ids={turnBlockIds(turn).join(" ")} className="flex flex-col gap-0 scroll-mt-4">
      {turn.user && <UserMessage block={turn.user} scope={scope} />}
      {showActivity && <AgentActivity blocks={turn.activityBlocks} lifecycle={turn.lifecycle} cwd={codeRunner?.cwd} hasFinalAnswer={Boolean(turn.finalAgent)} turnStartedAt={turn.startedAt ?? turn.user?.timestamp} turnEndedAt={turn.endedAt ?? turn.finalAgent?.timestamp} part={isLiveLifecycle(turn.lifecycle) ? "content" : "both"} />}
      {visibleAgent && <AgentMessage key={visibleAgent.id} block={visibleAgent} actionText={turn.finalAgent ? actionTextByBlock?.get(turn.finalAgent.id) : undefined} codeRunner={codeRunner} pinnedReferences={pinnedReferences} scope={scope} />}
      {(turn.active || turn.activityBlocks.length > 0) && isLiveLifecycle(turn.lifecycle) && <AgentActivity blocks={turn.activityBlocks} lifecycle={turn.lifecycle} cwd={codeRunner?.cwd} hasFinalAnswer={Boolean(turn.finalAgent)} turnStartedAt={turn.startedAt ?? turn.user?.timestamp} part="status" />}
      {turn.systemBlocks.map((block) => <SystemBlock key={block.id} block={block} pinnedReferences={pinnedReferences} />)}
      {turn.artifacts.map((block) => <TurnArtifactStrip key={block.id} artifacts={block.artifacts} cwd={codeRunner?.cwd} />)}
      {finalText && <ReferencedArtifactStrip text={finalText} cwd={codeRunner?.cwd} exclude={publishedPaths} />}
    </div>
  );
}

function UserMessage({ block, scope }: { block: UserMessageBlock; scope: MessageQuoteScope }) {
  const { t } = useTranslation();
  const sendPrompt = useRuntimeStore((state) => state.sendPrompt);
  const visibleText = visibleUserMessage(block.text);
  const references = referencesFromMessage(block.text);
  const copyText = visibleText || references.map((reference) => reference.path).join("\n");
  const selection = useMessageSelection({ blockId: block.id, role: "user", ...scope }, visibleText);
  const quoted = quotedMessagesFromMessage(block.text);
  return (
    <div id={messageAnchorId({ blockId: block.id, role: "user" })} className="group/message ml-auto flex max-w-[min(var(--user-message-width),82%)] scroll-mt-4 flex-col items-end gap-1">
      {/* The quote is part of the sent message, so it stays readable here: what
          the model received is what the transcript shows. */}
      {quoted.map((item, index) => <div key={index} className="max-w-full rounded-input border-l-2 border-accent/40 bg-surface-2/60 px-2 py-1 text-left">
        <div className="text-[10px] text-accent">
          {item.role === "user" ? t("conversation.quoteCardFromUser") : t("conversation.quoteCardFromAgent")}
          {" · "}
          {item.kind === "selection" ? t("conversation.quoteCardSelection") : t("conversation.quoteCardMessage")}
        </div>
        <div className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted">{item.text}</div>
      </div>)}
      {block.images && block.images.length > 0 && <div className="flex max-w-full flex-wrap justify-end gap-2" aria-label={t("conversation.attachedImages")}>
        {block.images.map((image, index) => <img key={`${image.mimeType}-${index}`} src={`data:${image.mimeType};base64,${image.data}`} alt={`Attachment ${index + 1}`} className="max-h-64 max-w-full rounded-input border border-border object-contain" />)}
      </div>}
      {visibleText && <div ref={selection.ref} className="ui-user-message rounded-bubble px-4 py-2.5 text-sm leading-relaxed text-text whitespace-pre-wrap">{visibleText}</div>}
      {selection.selection && <MessageSelectionQuoteMenu selection={selection.selection} onQuote={selection.quote} />}
      {references.length > 0 && <div className="flex flex-wrap justify-end gap-1.5" aria-label={t("conversation.referencedContext")}>
        {references.map((reference) => <span key={`${reference.isDir ? "folder" : "file"}-${reference.path}`} className="flex max-w-full items-center gap-1 rounded-input border border-accent/20 bg-accent/5 px-2 py-1 font-mono text-[10px] text-muted" title={reference.path}>
          {reference.isDir ? <FolderOpen size={10} /> : <File size={10} />}
          <span className="truncate">{reference.path}</span>
        </span>)}
      </div>}
      {block.deliveryStatus && block.deliveryStatus !== "pending" && <div role="status" className={cn("text-[10px]", block.deliveryStatus === "rejected" ? "text-error-text" : "text-muted")}>{t(`conversation.promptDelivery.${block.deliveryStatus}`)}</div>}
      {block.deliveryStatus === "rejected" && block.client_message_id && <button type="button" onClick={() => { void sendPrompt(block.text, block.client_message_id).catch(() => undefined); }} className="text-[10px] text-accent hover:underline">{t("conversation.promptDelivery.retrySameRequest")}</button>}
      <MessageActions text={copyText} timestamp={block.timestamp} align="right" quote={visibleText ? { blockId: block.id, role: "user", ...scope, messageText: visibleText } : undefined} />
    </div>
  );
}

function AgentMessage({ block, actionText, codeRunner, pinnedReferences, scope }: { block: AgentMessageBlock; actionText?: string; codeRunner?: CodeRunner; pinnedReferences?: ReadonlyMap<string, PublishedReference>; scope: MessageQuoteScope }) {
  const rawText = block.parts.map((part) => part.text).join("");
  const text = parseSuggestions(rawText).clean;
  const selection = useMessageSelection({ blockId: block.id, role: "agent", ...scope }, text);
  if (!rawText) return null;
  const citations = extractCitations(text);
  return <div className="group/message" id={messageAnchorId({ blockId: block.id, role: "agent" })}>
    <div ref={selection.ref}><MarkdownViewer variant="chat" codeRunner={codeRunner} mode={block.partial ? "streaming" : "final"} pinnedReferences={pinnedReferences}>{text}</MarkdownViewer></div>
    {selection.selection && <MessageSelectionQuoteMenu selection={selection.selection} onQuote={selection.quote} />}
    {citations.length > 0 && <CitationChips citations={citations} text={text} streaming={block.partial} />}
    {!block.partial && actionText && <MessageActions text={parseSuggestions(actionText).clean} timestamp={block.timestamp} quote={text ? { blockId: block.id, role: "agent", ...scope, messageText: text } : undefined} />}
  </div>;
}

/** Viewport anchor for the live selection. Kept inside the window so the action
 *  never lands half off screen; jsdom reports a zero rect, and a fixed fallback
 *  keeps the menu mountable in tests. */
function selectionAnchor(): { top: number; left: number } {
  const live = window.getSelection();
  const range = live && live.rangeCount > 0 ? live.getRangeAt(0) : null;
  const rect = range && typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  // Anchor above the selection and keep the action inside the viewport.
  const top = Math.max((rect?.top ?? 40) - 6, 34);
  const left = Math.min(Math.max(rect ? rect.left + rect.width / 2 : 56, 56), Math.max(window.innerWidth - 56, 56));
  return { top, left };
}

/** Selected text inside one message, plus the quote action for it. The menu is
 *  rendered by the caller, so a click can never reach the composer. */
function useMessageSelection(source: MessageQuoteSource, messageText: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<MessageSelectionAnchor | null>(null);
  const serial = useRef(0);
  const selectedText = useRef<string | null>(null);
  const setQuote = useMessageQuoteStore((state) => state.setQuote);
  useEffect(() => {
    const onChange = () => {
      const element = ref.current;
      const selected = element ? selectedTextWithin(element) : null;
      if (!selected) {
        selectedText.current = null;
        setSelection((previous) => previous === null ? previous : null);
        return;
      }
      if (selectedText.current !== selected) {
        selectedText.current = selected;
        serial.current += 1;
      }
      const at = selectionAnchor();
      setSelection((previous) => previous && previous.serial === serial.current && previous.top === at.top && previous.left === at.left ? previous : { text: selected, serial: serial.current, ...at });
    };
    // Scrolling leaves the selection alone but moves its rect, so the fixed menu
    // must re-anchor instead of drifting over whatever scrolled under it. Scroll
    // does not bubble, hence the capture phase.
    const onMove = () => {
      const live = window.getSelection();
      if (!live || live.rangeCount === 0 || live.isCollapsed) return;
      setSelection((previous) => {
        if (!previous) return previous;
        const at = selectionAnchor();
        return at.top === previous.top && at.left === previous.left ? previous : { ...previous, ...at };
      });
    };
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("resize", onMove);
    document.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, []);
  const quote = () => {
    const built = buildMessageQuote({ source, messageText, selection: selection?.text });
    if (built) setQuote(built);
    setSelection(null);
  };
  return { ref, selection, quote };
}

function SystemBlock({ block, pinnedReferences }: { block: ThreadBlock; pinnedReferences?: ReadonlyMap<string, PublishedReference> }) {
  if (block.kind === "status-line") return block.level === "error" || block.path ? <StatusLine block={block} pinnedReferences={pinnedReferences} /> : null;
  return null;
}

function StatusLine({ block, pinnedReferences }: { block: StatusLineBlock; pinnedReferences?: ReadonlyMap<string, PublishedReference> }) {
  const openInspector = useUiStore((state) => state.openInspector);
  const cwd = useRuntimeStore((state) => state.cwd);
  const tone = block.level === "error" ? "text-error-text" : block.level === "done" ? "text-ok-text" : "text-muted";
  if (block.path) {
    // A published reference opens the version its own turn reported; the live
    // file only shows for paths that were never published.
    const open = () => { void pinnedFileInspector(block.path!, undefined, "workspace", cwd, pinnedReferences?.get(normalizeArtifactPath(block.path!))).then((inspector) => openInspector(inspector)); };
    return <button type="button" onClick={open} className={cn("flex items-center gap-2 text-xs hover:underline", tone)}>{block.text}</button>;
  }
  return <div className={cn("flex items-center gap-2 text-xs", tone)}>{block.level === "info" && <Loader2 size={14} className="animate-spin text-accent" />}{block.text}</div>;
}
