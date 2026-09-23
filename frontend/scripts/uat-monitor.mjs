/**
 * Reusable real-time DOM monitor for Pi-Science conversation testing.
 *
 * Screenshots are slow and capture a single instant. This installs a
 * page-side sampler that records a structured snapshot of the conversation's
 * observable state and keeps only the transitions, so a whole turn can be
 * replayed from one cheap read.
 *
 * The sampler is driven by MutationObserver rather than a clock: in the ZCode
 * in-app browser `requestAnimationFrame` never fires and `setInterval` is
 * throttled to roughly one call per second, while MutationObserver runs on each
 * React commit.
 *
 * Install once per page load — a reload drops the monitor.
 *
 * From the Browser Use tool:
 *   const { MONITOR_SOURCE, READ_TRANSITIONS_SOURCE, formatTransitions } =
 *     await import("/abs/path/to/frontend/scripts/uat-monitor.mjs");
 *   await tab.playwright.evaluate(MONITOR_SOURCE);
 *   ...
 *   nodeRepl.write(formatTransitions(await tab.playwright.evaluate(READ_TRANSITIONS_SOURCE)));
 *
 * From Playwright:
 *   await page.addInitScript(MONITOR_SOURCE);
 */

/**
 * Installed in the page. Records transitions of:
 *   - every `[data-state]` activity row (state + label),
 *   - turn summary labels (`Completed …`, `Working …`),
 *   - generated / referenced artifact strips and their cards,
 *   - the conversation navigator entries,
 *   - the permission card (`role=alertdialog`),
 *   - whether a turn is running (the Stop-generation control).
 *
 * Ticking elapsed counters are collapsed before signing, otherwise the 4 Hz
 * turn clock would emit a record every tick and bury the real transitions.
 */
function installConversationMonitor() {
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const norm = (text) =>
    clean(text).replace(/\d+m\d+s/g, "…").replace(/\d+(\.\d+)?s\b/g, "…");

  const monitor = {
    startedAt: Date.now(),
    transitions: [],
    signature: null,
    observer: null,
    limit: 400,

    snapshot() {
      const rows = [...document.querySelectorAll("[data-state]")].map(
        (el) => `${el.getAttribute("data-state")}:${norm(el.textContent).slice(0, 70)}`,
      );
      const dialog = document.querySelector('[role="alertdialog"]');
      const nav = document.querySelector('nav[aria-label="Conversation"]');
      return {
        busy: [...document.querySelectorAll("button")].some(
          (b) => b.getAttribute("aria-label") === "Stop generation",
        ),
        summary: [...document.querySelectorAll("button")]
          .map((b) => norm(b.textContent))
          .filter((t) => /^(Completed|Working|Needs your input|等待)/.test(t))
          .map((t) => t.slice(0, 44)),
        rows,
        artifacts: [
          ...document.querySelectorAll(
            '[aria-label="Generated files"],[aria-label="Referenced files"]',
          ),
        ].map(
          (el) =>
            `${el.getAttribute("aria-label") === "Generated files" ? "GEN" : "REF"}:${[
              ...el.querySelectorAll("button"),
            ]
              .map((b) => (b.getAttribute("aria-label") || "").split(" (")[0])
              .join("+")}`,
        ),
        // The navigator is a stable per-turn list; the rendered message bubbles
        // are not, because the conversation virtualizes off-screen turns away.
        turns: nav ? nav.querySelectorAll("button").length : 0,
        dialog: dialog ? norm(dialog.textContent).slice(0, 80) : null,
      };
    },

    record() {
      const snapshot = monitor.snapshot();
      const signature = JSON.stringify(snapshot);
      if (signature === monitor.signature) return;
      monitor.signature = signature;
      monitor.transitions.push({ ms: Date.now() - monitor.startedAt, snapshot });
      if (monitor.transitions.length > monitor.limit) monitor.transitions.shift();
    },
  };

  monitor.record();
  monitor.observer = new MutationObserver(() => monitor.record());
  monitor.observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "data-state",
      "aria-expanded",
      "disabled",
      "aria-label",
      "data-thread-block-ids",
    ],
  });
  globalThis.__conversationMonitor = monitor;
  return { installed: true, baseline: monitor.transitions.length };
}

/** Reads the buffer. Pass `{ since }` to read only what arrived after a marker. */
function readConversationMonitor() {
  const monitor = globalThis.__conversationMonitor;
  if (!monitor) return { installed: false };
  const busyNow = [...document.querySelectorAll("button")].some(
    (b) => b.getAttribute("aria-label") === "Stop generation",
  );
  return {
    installed: true,
    elapsedMs: Date.now() - monitor.startedAt,
    total: monitor.transitions.length,
    busyNow,
    transitions: monitor.transitions,
  };
}

export const MONITOR_SOURCE = `(${installConversationMonitor.toString()})()`;
export const READ_TRANSITIONS_SOURCE = `(${readConversationMonitor.toString()})()`;

/** One line per transition, for pasting straight into a report. */
export function formatTransitions(log, since = 0) {
  if (!log || !log.installed) return "(monitor not installed)";
  const lines = log.transitions
    .filter((entry, index) => index >= since)
    .map((entry) => {
      const snap = entry.snapshot;
      const parts = [
        `busy=${snap.busy ? "Y" : "n"}`,
        `turns=${snap.turns}`,
        snap.dialog ? `DIALOG[${snap.dialog}]` : "",
        snap.summary.length ? `summary=${JSON.stringify(snap.summary)}` : "",
        snap.rows.length ? `rows=${JSON.stringify(snap.rows)}` : "",
        snap.artifacts.length ? `art=${JSON.stringify(snap.artifacts)}` : "",
      ].filter(Boolean);
      return `${String(entry.ms).padStart(7)}ms  ${parts.join("  ")}`;
    });
  return `${lines.join("\n")}\n(transitions: ${lines.length} of ${log.total}, busy=${log.busyNow})`;
}
