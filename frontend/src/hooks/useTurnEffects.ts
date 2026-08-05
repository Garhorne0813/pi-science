import { useEffect, useRef, useState } from "react";
import { useUiStore } from "../lib/ui";
import { extractArtifactRefs, fileInspectorFromBlock, publishedArtifactRefs, refToArtifactBlock } from "../lib/artifacts";
import { pickAutoPreviewArtifact } from "../lib/artifacts/artifact-autopreview";
import { parseSuggestions } from "../lib/conversation";
import type { ThreadBlock } from "../types/thread";

/**
 * Artifacts auto-preview + follow-up suggestions: when a live turn completes
 * (working true→false in this mount) with a NEW agent message, open the
 * newest previewable file in the inspector — same path as clicking the file
 * chip — and surface any `<!--suggest: …-->` follow-up chips it carries.
 * History replay never flips `working`, so it never triggers.
 */
export function useTurnEffects(working: boolean, blocks: ThreadBlock[]) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const wasWorkingRef = useRef(false);
  const turnStartAgentIdRef = useRef<string | null>(null);
  const autoPreviewedAgentIdRef = useRef<string | null>(null);
  useEffect(() => {
    const wasWorking = wasWorkingRef.current;
    wasWorkingRef.current = working;
    if (working === wasWorking) return;
    const lastAgent = blocks.findLast((block): block is Extract<ThreadBlock, { kind: "agent" }> => block.kind === "agent");
    if (working) { turnStartAgentIdRef.current = lastAgent?.id ?? null; setSuggestions([]); return; }
    if (!lastAgent || lastAgent.partial || lastAgent.id === turnStartAgentIdRef.current || lastAgent.id === autoPreviewedAgentIdRef.current) return;
    autoPreviewedAgentIdRef.current = lastAgent.id;
    const agentText = lastAgent.parts.map((part) => part.text).join("");
    setSuggestions(parseSuggestions(agentText).suggestions);
    const ui = useUiStore.getState();
    // Auto-preview only artifacts confirmed by a publication event. A path in
    // a plan is not evidence that the file was written to the workspace.
    const refs = publishedArtifactRefs(extractArtifactRefs(agentText), blocks);
    const pick = pickAutoPreviewArtifact(refs, { inspectorOpen: ui.inspectorOpen });
    if (pick) ui.openInspector(fileInspectorFromBlock(refToArtifactBlock(pick) as any) as any);
  }, [working, blocks]);

  return { suggestions, setSuggestions };
}
