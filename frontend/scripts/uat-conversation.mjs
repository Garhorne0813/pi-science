import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "./browser-executable.mjs";


const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const backend = process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787";
const chromePath = await resolveBrowserExecutable();
const workspace = path.join(os.tmpdir(), `pi-science-conversation-uat-${process.pid}`);
const screenshot = path.join(os.tmpdir(), "pi-science-conversation-uat.png");
const browserApiOrigins = new Set([new URL(frontend).origin, new URL(backend).origin]);
const fixtureSessionId = randomUUID();
const fixturePath = path.join(workspace, ".pi-science", "sessions", `${fixtureSessionId}.jsonl`);


async function api(endpoint, init, expectedRuntime = "node-control-plane") {
  const response = await fetch(`${backend}${endpoint}`, init);
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  const runtime = response.headers.get("x-pi-science-runtime");
  if (expectedRuntime && runtime !== expectedRuntime) {
    throw new Error(`${endpoint}: expected ${expectedRuntime} runtime, got ${runtime || "missing header"}`);
  }
  return response.json();
}


function sessionIdFromUrl(url) {
  const match = /\/session\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}


const q = (value) => encodeURIComponent(String(value));


function assert(condition, message) {
  if (!condition) throw new Error(`UAT assertion failed: ${message}`);
}


/** Deterministic long session fixture: 120 persisted messages (alternating
 *  user/assistant), then one appended assistant reply. The hand-written m-N
 *  ids are placeholders only: activating the session in the browser makes the
 *  Pi runtime canonicalize the transcript with its own generated ids, and
 *  every fixture assertion keys off the stable message TEXT re-discovered
 *  after that canonicalization. */
async function writeFixtureSession() {
  const rows = [JSON.stringify({ type: "session", id: fixtureSessionId, cwd: workspace })];
  for (let i = 1; i <= 120; i += 1) {
    const role = i % 2 === 1 ? "user" : "assistant";
    const text = `${role} #${i}: plain navigation fixture text ${i}`;
    rows.push(JSON.stringify({
      type: "message",
      id: `m-${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      message: { role, content: [{ type: "text", text }] },
    }));
  }
  await writeFile(fixturePath, `${rows.join("\n")}\n`, "utf8");
}


/** Read the fixture transcript and index messages by exact text. After the
 *  runtime canonicalization the ids are runtime-generated, so fixture
 *  interactions key off the stable message TEXT. */
async function readFixtureMessages() {
  const text = await readFile(fixturePath, "utf8");
  const byText = new Map();
  const messages = [];
  for (const line of text.split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.type !== "message" || !entry.message) continue;
    const parts = Array.isArray(entry.message.content) ? entry.message.content : [];
    const messageText = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!messageText) continue;
    messages.push({ id: String(entry.id), role: String(entry.message.role), text: messageText });
    byText.set(messageText, String(entry.id));
  }
  return { messages, idOf: (messageText) => byText.get(messageText) ?? null };
}


/** Activate the fixture session in the browser so the Pi runtime takes over
 *  the transcript: the command/state activation canonicalizes the JSONL with
 *  runtime-generated message ids (the hand-written m-N ids disappear). Polls
 *  until the canonicalization is visible in the file. When the Pi runtime is
 *  unavailable (no session activation), the transcript keeps its hand-written
 *  ids: the caller then SKIPs the browser fixture phase but can still run the
 *  Node API checks against the stable message texts. Returns the post-rewrite
 *  message index plus whether canonicalization actually happened. */
async function primeFixtureSession(page) {
  await page.goto(`${frontend}/workspace/${encodeURIComponent(workspace)}/session/${encodeURIComponent(fixtureSessionId)}`, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 90_000;
  for (;;) {
    const fixture = await readFixtureMessages().catch(() => ({ messages: [], idOf: () => null }));
    const anchorId = fixture.idOf("user #25: plain navigation fixture text 25");
    const canonicalized = anchorId !== null && anchorId !== "m-25";
    if (canonicalized && fixture.messages.length >= 120) return { fixture, canonicalized: true };
    if (Date.now() > deadline) {
      // The Pi runtime never rewrote the transcript (no runtime / activation
      // failed). The hand-written fixture is still readable and its message
      // texts are stable, so the Node API checks can run against those ids.
      if (fixture.messages.length >= 120) return { fixture, canonicalized: false };
      throw new Error("fixture transcript is unreadable even without runtime canonicalization");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The activation page parks at the bottom and its debounced read-state
 *  writes (bottom snap + mark-seen, 300–400ms debounce) can land AFTER the
 *  file canonicalization that primeFixtureSession observes. Wait until the
 *  read-state settles (at_bottom write landed, then stable for 1s) so the
 *  baseline reset in the API phase cannot race a late activation write.
 *  Bounded: never hang the UAT on a page that never settles. */
async function waitForActivationReadStateSettle() {
  const base = (extra = "") => `?cwd=${q(workspace)}${extra}`;
  const deadline = Date.now() + 30_000;
  let state = null;
  for (;;) {
    state = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`);
    if (state.at_bottom === true) break;
    if (Date.now() > deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // The at_bottom write landed; the debounced mark-seen can still follow.
  // Wait until the read-state stops changing so the baseline reset below
  // cannot race a late write.
  const stableDeadline = Date.now() + 10_000;
  let previous = JSON.stringify(state);
  let stableSince = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`);
    const serialized = JSON.stringify(state);
    if (serialized === previous) {
      if (Date.now() - stableSince >= 1000) return state;
    } else {
      previous = serialized;
      stableSince = Date.now();
    }
    if (Date.now() > stableDeadline) return state;
  }
}


/** Probe whether the Pi runtime can be spawned by the control plane, BEFORE
 *  the browser fixture phase. Creates a throwaway session in a scratch
 *  workspace through the Node API: a created session proves the runtime
 *  started (session activation / transcript canonicalization will work); a
 *  spawn failure (PI_CLI_PATH missing, runtime initialization failure) proves
 *  the runtime is unavailable and legitimizes the SKIP branch for the browser
 *  fixture phase. The probe workspace and session are deleted afterwards. */
async function detectRuntimeAvailability() {
  const probeWorkspace = path.join(os.tmpdir(), `pi-science-conversation-uat-probe-${process.pid}`);
  await mkdir(path.join(probeWorkspace, ".pi-science", "sessions"), { recursive: true });
  try {
    const response = await fetch(`${backend}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: probeWorkspace }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.log(`runtime availability probe failed (${response.status}): ${body.slice(0, 300)}`);
      return false;
    }
    const created = await response.json();
    if (!created || typeof created.id !== "string") return false;
    await fetch(`${backend}/api/sessions/${encodeURIComponent(created.id)}?cwd=${q(probeWorkspace)}`, { method: "DELETE" }).catch(() => undefined);
    return true;
  } catch (error) {
    console.log(`runtime availability probe errored: ${String(error)}`);
    return false;
  } finally {
    await rm(probeWorkspace, { recursive: true, force: true });
  }
}


/** Poll the bookmarks list until a bookmark for `messageId` reaches `status`
 *  (the UI writes are async; the server write is atomic). */
async function waitForBookmarkState(messageId, status) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const list = await api(`/api/bookmarks?cwd=${q(workspace)}&session_id=${fixtureSessionId}`);
    const found = list.bookmarks.find((bookmark) => bookmark.message_id === messageId);
    if (found && found.status === status) return found;
    if (Date.now() > deadline) throw new Error(`bookmark ${messageId} did not reach ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}


/** Viewport-evidence contract for a navigation target, bounded-polled: the
 *  target message's DOM node must actually INTERSECT the
 *  `.conversation-scroller` viewport (target rect overlaps the scroller rect)
 *  at least once within the deadline. Virtuoso may virtualize the target away
 *  between samples and remount it later, so the poll tolerates transient
 *  absence and only requires one intersecting sample. */
async function expectViewportAnchor(page, anchorId, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let sawUserAnchor = false;
  let sawAssistantAnchor = false;
  for (;;) {
    const sample = await page.evaluate((id) => {
      const scroller = document.querySelector(".conversation-scroller");
      if (!scroller) return { userAttached: false, assistantAttached: false, intersects: false };
      const scrollerRect = scroller.getBoundingClientRect();
      const userEl = document.getElementById(`user-msg-${id}`);
      const assistantEl = document.getElementById(`agent-msg-${id}`);
      const intersects = [userEl, assistantEl].some((el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0
          && r.left < scrollerRect.right && r.right > scrollerRect.left
          && r.top < scrollerRect.bottom && r.bottom > scrollerRect.top;
      });
      return {
        userAttached: Boolean(userEl),
        assistantAttached: Boolean(assistantEl),
        intersects,
      };
    }, anchorId);
    sawUserAnchor ||= sample.userAttached;
    sawAssistantAnchor ||= sample.assistantAttached;
    if (sample.intersects) {
      console.log(`PASS ${description}: target message DOM intersects the conversation viewport`);
      return;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = await page.evaluate((id) => {
    const scroller = document.querySelector(".conversation-scroller");
    const navRow = document.querySelector(`[data-nav-id="${id}"]`);
    return {
      url: window.location.pathname,
      targetInDom: Boolean(document.getElementById(`user-msg-${id}`)) || Boolean(document.getElementById(`agent-msg-${id}`)),
      userMsgCount: document.querySelectorAll("[id^='user-msg-']").length,
      scroller: scroller ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null,
      navRow: navRow ? navRow.getAttribute("aria-current") : "missing",
      navActive: document.querySelector("[aria-current='true']")?.getAttribute("data-nav-id") ?? null,
      navItemCount: document.querySelectorAll("[data-nav-id]").length,
      threadBlocks: document.querySelectorAll(".group\\/message").length,
    };
  }, anchorId);
  const kind = sawAssistantAnchor ? "assistant" : sawUserAnchor ? "user" : "unknown";
  throw new Error(`${description}: target message never intersected the .conversation-scroller viewport (${kind} anchor); page state ${JSON.stringify(state)}`);
}


/** Deterministic switch-out readiness before re-anchoring and re-entering a
 *  session. The URL no longer matching /session/ only proves the route
 *  changed — not that the LiveSessionPage disconnected and cleared the
 *  thread. Use the same deterministic signal as the live-session branch: the
 *  landing's welcome h2 renders ONLY once the thread is blank and ready (the
 *  sidebar h1 logo is always present and must NOT be used as the signal),
 *  and the conversation scroller is gone from the DOM, i.e. the session page
 *  unmounted and its debounced read-state writes / restore timers are dead.
 *  Re-entering before this readiness can retain the fixture history, in
 *  which case the restore legitimately does not issue the exact-cursor
 *  request and the UAT would time out waiting for it. */
async function waitForLandingReady(page) {
  try {
    await page.locator("h2", { hasText: "Pi-Science" }).waitFor({ timeout: 20_000 });
  } catch (error) {
    throw new Error(`landing welcome h2 never rendered within 20s — the session page did not finish switch-out (blank thread); re-entering before this readiness can retain the fixture history and skip the exact-cursor restore: ${error.message}`);
  }
  await page.waitForFunction(() => !document.querySelector(".conversation-scroller"), undefined, { timeout: 20_000 });
}


/** Wait for the external model's streamed response text to settle. The model
 *  provider is NOT part of the ownership contract (session create + prompt +
 *  SSE are served by node-control-plane with node-native SSE regardless of
 *  the model), so a provider flake must not kill the UAT once ownership is
 *  already proven. On timeout the recorded ownership evidence is verified:
 *  proven → log SKIP and return false (the navigation fixture UAT still
 *  runs); not proven → rethrow, because a missing model response cannot mask
 *  an ownership break. */
async function waitForModelSettlement(page, text, description, sessionRuntimeChecks) {
  try {
    await page.getByText(text, { exact: true }).waitFor({ timeout: 120_000 });
    return true;
  } catch (error) {
    const observed = await Promise.all(sessionRuntimeChecks);
    const ownershipProven = observed.length > 0
      && observed.every((item) => item.runtime === "node-control-plane")
      && observed.some((item) => item.method === "POST" && item.path === "/api/sessions")
      && observed.some((item) => item.method === "POST" && item.path.endsWith("/prompt"))
      && observed.some((item) => item.path.endsWith("/events") && item.sse === "node-native");
    if (!ownershipProven) throw error;
    console.log(`SKIP live-model ${description} settlement: external model did not stream ${JSON.stringify(text)} within 120s, but node-control-plane ownership was already proven (create/prompt/SSE) — continuing with the navigation fixture UAT`);
    return false;
  }
}


/** Model-free durable-navigation coverage through the Node API: read-state
 *  anchors + exact cursor resolution, pagination, mark-seen, manual bookmarks
 *  on an old USER and an old ASSISTANT message (durable, idempotent,
 *  server-side role/quote), and the attention idle→unread transition after a
 *  new assistant reply. Runs against the POST-rewrite transcript (`fx`), so
 *  every id comes from the runtime-owned file and the server/UI always agree.
 *  Heuristic proposal permutations are deliberately NOT exercised here: they
 *  depend on the suggestion heuristic, not on navigation. */
async function runNavigationApiUat(fx) {
  const base = (extra = "") => `?cwd=${q(workspace)}${extra}`;
  const anchorText = "user #25: plain navigation fixture text 25";
  const anchorId = fx.idOf(anchorText);
  assert(anchorId, `fixture transcript must contain the anchor text: ${anchorText}`);
  const firstUserText = "user #1: plain navigation fixture text 1";
  const firstUserId = fx.idOf(firstUserText);
  assert(firstUserId, `fixture transcript must contain the old user text: ${firstUserText}`);
  const secondAssistantText = "assistant #2: plain navigation fixture text 2";
  const secondAssistantId = fx.idOf(secondAssistantText);
  assert(secondAssistantId, `fixture transcript must contain the old assistant text: ${secondAssistantText}`);

  // Baseline: the activation page parked at the bottom and wrote its
  // read-state (at_bottom + mark-seen) BEFORE this phase (the caller waited
  // for it to settle when the runtime canonicalized the transcript); reset to
  // a clean anchor-less reading position so the anchors below start from a
  // deterministic state.
  await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anchor_message_id: null, at_bottom: false }),
  });
  const readEmpty = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`);
  assert(readEmpty.anchor_message_id === null && readEmpty.at_bottom === false, `clean read-state should be anchor-less, got ${JSON.stringify(readEmpty)}`);
  assert(readEmpty.anchor_available === false && readEmpty.before === null, "clean read-state should not resolve an anchor");

  const anchored = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anchor_message_id: anchorId, at_bottom: false }),
  });
  assert(anchored.anchor_message_id === anchorId && anchored.at_bottom === false, `anchor write failed: ${JSON.stringify(anchored)}`);
  assert(anchored.anchor_available === true, "anchored read-state must report the anchor as available");
  const exactBefore = anchored.before;
  assert(typeof exactBefore === "string" && exactBefore.length > 0, "anchored read-state must resolve a dynamic before cursor");

  const anchorPage = await api(`/api/sessions/${fixtureSessionId}/messages${base(`&before=${q(exactBefore)}`)}`);
  assert(anchorPage.messages.some((message) => message.id === anchorId), "paged history with the exact saved cursor did not include the anchor message");
  assert(typeof anchorPage.snapshot_version === "string" && anchorPage.snapshot_version.length > 0, "messages page must report a snapshot_version");

  const newestPage = await api(`/api/sessions/${fixtureSessionId}/messages${base()}`);
  assert(newestPage.messages.some((message) => message.id === fx.messages[fx.messages.length - 1].id), "newest history page missing the last fixture message");
  assert(newestPage.has_more === true && typeof newestPage.next_cursor === "string" && newestPage.next_cursor.length > 0, "120-message fixture must paginate");

  const seen = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ at_bottom: true, mark_seen: true }),
  });
  assert(seen.at_bottom === true && typeof seen.seen_snapshot_version === "string" && seen.seen_snapshot_version.length > 0, "mark-seen must persist the server-side snapshot version");

  // Attention normalization: mark-seen above persisted the CURRENT snapshot as
  // seen and nothing writes the session file before the append below, so the
  // idle assertion is deterministic (it must NOT run before the reset/mark-seen
  // normalization — a late activation write could still flip the status).
  const attentionBefore = await api(`/api/attention${base("&limit=100")}`);
  const beforeItem = attentionBefore.items.find((item) => item.session_id === fixtureSessionId);
  assert(beforeItem, "fixture session is missing from the attention queue");
  assert(beforeItem.status === "idle", `fixture session should be idle after reset/mark-seen normalization, got ${beforeItem.status}`);

  // Exact pagination cursors for the old jump targets: the index resolves a
  // deterministic byte-offset cursor per message, and the browser jumps must
  // reproduce these EXACT cursors.
  const indexAll = await api(`/api/sessions/${fixtureSessionId}/messages/index${base("&roles=all")}`);
  const firstEntry = indexAll.messages.find((entry) => entry.id === firstUserId);
  const secondEntry = indexAll.messages.find((entry) => entry.id === secondAssistantId);
  assert(firstEntry && typeof firstEntry.before === "string" && firstEntry.before.length > 0, "index must resolve a pagination cursor for the old user message");
  assert(secondEntry && typeof secondEntry.before === "string" && secondEntry.before.length > 0, "index must resolve a pagination cursor for the old assistant message");

  // Manual bookmarks: one old USER message and one old ASSISTANT message, so
  // the browser phase can validate both jump kinds. Role/quote are resolved
  // server-side from the session JSONL, never from the client payload.
  const firstBookmark = await api(`/api/bookmarks${base(`&session_id=${fixtureSessionId}`)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: firstUserId, label: "very first question" }),
  });
  assert(firstBookmark.bookmark.status === "accepted" && firstBookmark.bookmark.origin === "user", `manual user bookmark should be accepted: ${JSON.stringify(firstBookmark.bookmark)}`);
  assert(firstBookmark.bookmark.role === "user" && firstBookmark.bookmark.quote.includes(firstUserText), "user bookmark role/quote must be resolved server-side");

  const secondBookmark = await api(`/api/bookmarks${base(`&session_id=${fixtureSessionId}`)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: secondAssistantId, label: "second assistant answer" }),
  });
  assert(secondBookmark.bookmark.status === "accepted" && secondBookmark.bookmark.origin === "user", `manual assistant bookmark should be accepted: ${JSON.stringify(secondBookmark.bookmark)}`);
  assert(secondBookmark.bookmark.role === "assistant" && secondBookmark.bookmark.quote.includes(secondAssistantText), "assistant bookmark role/quote must be resolved server-side");

  // Append a new assistant reply so the unread transition has a real target.
  const appendedId = `uat-${Date.now()}`;
  await appendFile(fixturePath, `${JSON.stringify({
    type: "message",
    id: appendedId,
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "final result: verified completed（编号 121）" }] },
  })}\n`, "utf8");
  const attentionUnread = await api(`/api/attention${base("&limit=100")}`);
  const unreadItem = attentionUnread.items.find((item) => item.session_id === fixtureSessionId);
  assert(unreadItem?.status === "unread", `appended assistant reply should flip attention to unread, got ${unreadItem?.status}`);
  assert(attentionUnread.counts.unread >= 1, "attention counts must include the unread fixture session");
  const appendedPage = await api(`/api/sessions/${fixtureSessionId}/messages${base()}`);
  assert(appendedPage.messages.some((message) => message.id === appendedId), "newest history page must include the appended reply");

  console.log("PASS fixture attention starts idle and flips to unread after a new assistant reply");
  console.log("PASS read-state anchors persist, resolve the exact paginated cursor, and mark-seen stores the snapshot");
  console.log("PASS old user + old assistant bookmarks are durable and server-resolved");
  console.log("PASS 120-message history paginates with has_more/next_cursor/snapshot_version");
  return { anchorId, exactBefore, firstUserId, secondAssistantId, appendedId };
}


/** Browser coverage on the fixture session: reading-position restore with the
 *  EXACT saved cursor (canonical read-state preserved; Virtuoso DOM mount
 *  timing is deliberately not part of the persistence contract), a real
 *  switch-out-and-return re-restore, reload durability, old USER and old
 *  ASSISTANT bookmark jumps with exact cursors, back-to-latest with the
 *  canonical seen state, and Node runtime ownership of the browser's
 *  navigation API calls. All message ids come from the runtime-owned
 *  transcript (`fx`). */
async function runNavigationBrowserUat(page, fx, navigationRuntimeChecks) {
  const base = (extra = "") => `?cwd=${q(workspace)}${extra}`;
  const anchorText = "user #25: plain navigation fixture text 25";
  const anchorId = fx.idOf(anchorText);
  const firstText = "user #1: plain navigation fixture text 1";
  const firstId = fx.idOf(firstText);
  const secondAssistantText = "assistant #2: plain navigation fixture text 2";
  const secondAssistantId = fx.idOf(secondAssistantText);
  assert(anchorId && firstId && secondAssistantId, "runtime transcript must contain the anchor and jump texts");

  const sessionMessagesPath = `/api/sessions/${encodeURIComponent(fixtureSessionId)}/messages`;
  /** Resolves with the paged-history response that used the EXACT cursor. */
  const messagesResponse = (cursor) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === sessionMessagesPath && url.searchParams.get("before") === cursor;
  }, { timeout: 30_000 });

  const waitForReadState = async (predicate, description, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`);
      if (predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`${description}: ${JSON.stringify(state)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  // Exact jump cursors from the server index (deterministic byte offsets).
  const indexAll = await api(`/api/sessions/${fixtureSessionId}/messages/index${base("&roles=all")}`);
  const cursorOf = (messageId) => indexAll.messages.find((entry) => entry.id === messageId)?.before ?? null;

  // Restore anchor: enter the fixture at an OLD page and reload. The restore
  // must request the EXACT saved cursor, resolve the anchor in that response,
  // and leave the canonical read-state (anchor + at_bottom false) untouched.
  // Virtuoso DOM mount timing is not part of the persistence contract (a
  // virtualized list may unmount the restored anchor after placing it), so
  // no DOM-attached assertion is made here.
  const anchored = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anchor_message_id: anchorId, at_bottom: false }),
  });
  const exactBefore = anchored.before;
  assert(typeof exactBefore === "string" && exactBefore.length > 0, "read-state must resolve the saved anchor cursor");
  // The page has been sitting at the bottom of the fixture session since the
  // activation: its debounced read-state writes (bottom snap / mark-seen /
  // rail anchor) can land AFTER the API phase and clobber the anchor above.
  // Leave the session first — unmount cancels the pending writes — then
  // re-assert the anchored state on a quiet page and re-enter. The URL alone
  // is not enough: wait for the landing welcome h2 (blank thread) and the
  // session page unmount before re-anchoring, or the re-enter can retain the
  // fixture history and the restore legitimately skips the exact-cursor
  // request.
  // Leave the session through the app's own "New conversation" action, NOT a
  // full page load of the landing: a fresh root entry with persisted sessions
  // re-triggers the sidebar auto-session-nav (which auto-opens the most recent
  // session and yanks the page back into the fixture), so the welcome h2
  // would never render. The click sets the auto-nav suppression marker and
  // lands on the root deterministically — the same path the live-model phase
  // and the switch-out below use.
  await page.getByTitle("New conversation").click();
  await page.waitForFunction(() => !window.location.pathname.match(/\/session\/[^/]+$/), undefined, { timeout: 20_000 });
  await waitForLandingReady(page);
  const reanchored = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anchor_message_id: anchorId, at_bottom: false }),
  });
  assert(reanchored.anchor_message_id === anchorId && reanchored.at_bottom === false, `re-anchored read-state should be canonical, got ${JSON.stringify(reanchored)}`);
  const restorePage = messagesResponse(exactBefore);
  await page.goto(`${frontend}/workspace/${encodeURIComponent(workspace)}/session/${encodeURIComponent(fixtureSessionId)}`, { waitUntil: "domcontentloaded" });
  let restoreBody;
  try {
    restoreBody = await (await restorePage).json();
  } catch (error) {
    throw new Error(`initial restore did not settle within 30s: the exact-cursor history request (before=${exactBefore}) was never served — the session page likely retained the fixture history instead of restoring (switch-out must fully clear the thread before re-entry): ${error.message}`);
  }
  assert(restoreBody.messages.some((message) => message.id === anchorId), "restore page must contain the saved anchor");
  await waitForReadState((state) => state.anchor_message_id === anchorId && state.at_bottom === false && state.anchor_available === true, "restore must keep the canonical anchor read-state");
  await expectViewportAnchor(page, anchorId, "reading-position restore");
  console.log("PASS restored reading position on the exact saved cursor (response + canonical read-state + viewport anchor)");

  // Durable accepted bookmark for the anchor, API-created: the browser
  // message-action toggle needs the message DOM attached, which is not part
  // of the persistence contract, so the server-side bookmark API stands in.
  const anchorBookmark = await api(`/api/bookmarks${base(`&session_id=${fixtureSessionId}`)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: anchorId, label: anchorText }),
  });
  assert(anchorBookmark.bookmark.status === "accepted" && anchorBookmark.bookmark.role === "user", `anchor bookmark should be accepted with server-resolved role: ${JSON.stringify(anchorBookmark.bookmark)}`);
  await waitForBookmarkState(anchorId, "accepted");
  console.log("PASS anchor bookmark is durable and accepted (server-resolved role/quote)");

  // Truly switch out and return: the landing clears the restore guard, so
  // re-entering the session must restore the SAME saved cursor again. Apply
  // the same switch-out readiness as the initial restore (welcome h2 + the
  // session page's scroller unmounted) so the return cannot start on
  // retained fixture history.
  await page.getByTitle("New conversation").click();
  await page.waitForFunction(() => !window.location.pathname.match(/\/session\/[^/]+$/), undefined, { timeout: 20_000 });
  await waitForLandingReady(page);
  const returnPage = messagesResponse(exactBefore);
  await page.goto(`${frontend}/workspace/${encodeURIComponent(workspace)}/session/${encodeURIComponent(fixtureSessionId)}`, { waitUntil: "domcontentloaded" });
  let returnBody;
  try {
    returnBody = await (await returnPage).json();
  } catch (error) {
    throw new Error(`switch-out return restore did not settle within 30s: the exact-cursor history request (before=${exactBefore}) was never served — the return re-entered the session before the landing cleared the thread: ${error.message}`);
  }
  assert(returnBody.messages.some((message) => message.id === anchorId), "return page must contain the saved anchor");
  await waitForReadState((state) => state.anchor_message_id === anchorId && state.at_bottom === false && state.anchor_available === true, "return must keep the canonical anchor read-state");
  await expectViewportAnchor(page, anchorId, "switch-out-and-return re-restore");
  console.log("PASS switching away and back re-restored the saved anchor (response + canonical read-state + viewport anchor)");

  // Durability across a full reload: reading position and all three
  // bookmarks (all API-created) survive.
  const reloadPage = messagesResponse(exactBefore);
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadBody = await (await reloadPage).json();
  assert(reloadBody.messages.some((message) => message.id === anchorId), "reload page must contain the saved anchor");
  // A cold reload may leave Virtuoso with the restored anchor unmounted, so
  // persistence is asserted on the exact-cursor response body and the
  // canonical read-state (anchor + at_bottom false) — and the non-pixel
  // viewport check below requires the anchor DOM to attach at least once
  // (Virtuoso remounting it later is fine).
  await waitForReadState((state) => state.anchor_message_id === anchorId && state.at_bottom === false && state.anchor_available === true, "reload must keep the canonical anchor read-state");
  await expectViewportAnchor(page, anchorId, "reload restore");
  await page.getByRole("button", { name: "Bookmarks" }).click();
  await page.getByRole("button", { name: `${anchorText} — Jump to message` }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "very first question — Jump to message" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "second assistant answer — Jump to message" }).waitFor({ timeout: 15_000 });
  console.log("PASS bookmarks and reading position survived a full reload");

  // Old USER bookmark jump: exact cursor and response (no DOM-mount oracle).
  const firstBefore = cursorOf(firstId);
  assert(typeof firstBefore === "string" && firstBefore.length > 0, "index must resolve a cursor for the old user message");
  const firstJumpPage = messagesResponse(firstBefore);
  await page.getByRole("button", { name: "very first question — Jump to message" }).click();
  const firstJumpBody = await (await firstJumpPage).json();
  assert(firstJumpBody.messages.some((message) => message.id === firstId), "old user jump page must contain the bookmarked message");
  await expectViewportAnchor(page, firstId, "old-user bookmark jump");
  console.log("PASS old-user bookmark jump loaded the exact cursor page and attached its target");

  // Old ASSISTANT bookmark jump: the same contract for an assistant anchor.
  const secondBefore = cursorOf(secondAssistantId);
  assert(typeof secondBefore === "string" && secondBefore.length > 0, "index must resolve a cursor for the old assistant message");
  const secondJumpPage = messagesResponse(secondBefore);
  await page.getByRole("button", { name: "second assistant answer — Jump to message" }).click();
  const secondJumpBody = await (await secondJumpPage).json();
  assert(secondJumpBody.messages.some((message) => message.id === secondAssistantId), "old assistant jump page must contain the bookmarked message");
  await expectViewportAnchor(page, secondAssistantId, "old-assistant bookmark jump");
  console.log("PASS old-assistant bookmark jump loaded the exact cursor page and attached its target");

  // Back to latest: the viewport returns to the newest content and the
  // debounced mark-seen converges on the CANONICAL server snapshot. One click
  // is not enough: the reading-position restore's tail can still be unwinding
  // (its write suppression runs up to the ~31s budget+settle+safety window)
  // and a late bookmark-jump scroll callback can yank the viewport back to
  // the old page, leaving the button visible and at_bottom false. Re-click
  // whenever the button is still visible or at_bottom has not landed, bounded
  // to ~35s; the final assertion is NOT weakened — the canonical seen
  // snapshot must still land.
  const backToLatest = page.getByLabel("Back to latest");
  await backToLatest.waitFor({ timeout: 15_000 });
  const canonicalSnapshot = (await api(`/api/sessions/${fixtureSessionId}/messages/index${base()}`)).snapshot_version;
  assert(typeof canonicalSnapshot === "string" && canonicalSnapshot.length > 0, "index must report a canonical snapshot_version");
  const backToLatestDeadline = Date.now() + 35_000;
  let backToLatestState = null;
  for (;;) {
    if (await backToLatest.isVisible().catch(() => false)) {
      await backToLatest.click({ timeout: 5_000 }).catch(() => undefined);
    }
    backToLatestState = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`);
    if (backToLatestState.at_bottom === true && backToLatestState.seen_snapshot_version === canonicalSnapshot) break;
    if (Date.now() > backToLatestDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert(
    backToLatestState.at_bottom === true && backToLatestState.seen_snapshot_version === canonicalSnapshot,
    `back-to-latest must mark the canonical snapshot as seen, final state ${JSON.stringify(backToLatestState)}`,
  );
  console.log("PASS back-to-latest persisted at_bottom and the canonical seen snapshot");

  // Runtime ownership of the browser's navigation API calls.
  const navChecks = await Promise.all(navigationRuntimeChecks);
  assert(navChecks.length > 0, "browser made no navigation API requests");
  const wrongNav = navChecks.find((item) => item.runtime !== "node-control-plane");
  assert(!wrongNav, `navigation API escaped Node ownership: ${JSON.stringify(wrongNav)}`);
  assert(navChecks.some((item) => item.method === "GET" && item.path.startsWith("/api/bookmarks")), "browser never fetched bookmarks");
  assert(navChecks.some((item) => item.method === "GET" && item.path.startsWith("/api/attention")), "browser never fetched the attention queue");
  assert(navChecks.some((item) => item.method === "GET" && item.path.endsWith("/messages")), "browser never paged history");
  console.log("PASS browser bookmark/read-state/attention/messages requests were owned by node-control-plane");

  // Session delete must also remove its navigation state.
  const deleted = await fetch(`${backend}/api/sessions/${encodeURIComponent(fixtureSessionId)}${base()}`, { method: "DELETE" });
  assert(deleted.ok, `fixture session delete failed: ${deleted.status}`);
  const afterDelete = await api(`/api/bookmarks${base()}`);
  assert(!afterDelete.bookmarks.some((bookmark) => bookmark.session_id === fixtureSessionId), "fixture bookmarks survived session delete");
  let readAfterDelete;
  try {
    readAfterDelete = await api(`/api/sessions/${fixtureSessionId}/read-state${base()}`);
  } catch {
    readAfterDelete = { not_found: true };
  }
  assert(readAfterDelete.not_found === true, "read-state should 404 after the session is deleted");
  console.log("PASS session delete cleaned up bookmarks and read state");
}


async function run() {
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(workspace, ".pi-science", "sessions"), { recursive: true });
  await api("/api/health");
  const config = await api("/api/settings/config");
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
  const runtimeErrors = [];
  const createdSessions = [];
  const sessionRuntimeChecks = [];
  const navigationRuntimeChecks = [];
  // Browser runtime failures are FAIL-CLOSED with EXACT response tuples.
  // Console "Failed to load resource" messages carry no URL, so they cannot
  // be correlated by status alone (a status-only match could mask an
  // unrelated failure that happens to share the status). Instead every non-ok
  // browser response is accounted for exactly at the response event:
  //   - a response whose method+pathname+status matches a known-benign tuple
  //     is tracked as benign (its generic URL-less console message is then
  //     ignored — all non-ok responses are accounted for, so no real failure
  //     can hide behind that message);
  //   - ANY other non-ok response is recorded as a runtime failure directly.
  // The known-benign surface:
  //   - 404s for navigation queries of a brand-new session whose JSONL the Pi
  //     runtime has not flushed yet (read-state / messages / index / state /
  //     commands for the just-created session id, or bookmarks with its
  //     session_id) — the UI hooks deliberately catch those and degrade to
  //     empty data;
  //   - the fixture-canonicalization invalid_anchor 422: the activation page
  //     can still hold the hand-written m-N ids when the runtime rewrites the
  //     transcript, and its debounced read-state anchor PUT is then rejected
  //     by the server (the UI deliberately catches and drops that write).
  // An unrelated 404/422 response on any other tuple therefore FAILS the UAT.
  const benignNonOk = new Set(); // exact "METHOD pathname STATUS" tuples seen as benign
  const createdSessionIds = new Set();
  const benignNonOkKey = (method, url, status) => {
    if (status === 404 && method === "GET") {
      const sessionMatch = /^\/api\/sessions\/([^/]+)\/(read-state|messages|messages\/index|state|commands)$/.exec(url.pathname);
      const sessionId = sessionMatch ? decodeURIComponent(sessionMatch[1]) : null;
      if (sessionId && createdSessionIds.has(sessionId)) return `${method} ${url.pathname} 404`;
      if (url.pathname === "/api/bookmarks") {
        const bookmarkedSession = url.searchParams.get("session_id");
        if (bookmarkedSession !== null && createdSessionIds.has(bookmarkedSession)) return `${method} ${url.pathname} 404`;
      }
    }
    if (status === 422 && method === "PUT" && url.pathname === `/api/sessions/${fixtureSessionId}/read-state`) {
      return `${method} ${url.pathname} 422`;
    }
    return null;
  };
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Status-bearing resource-load messages are ignored: they carry no URL
    // and are fully redundant with the response-based accounting above (every
    // non-ok response is either a tracked benign tuple or already recorded as
    // a runtime failure). URL-less network-level failures (net::ERR_*) have
    // no response event and remain runtime failures.
    if (/^Failed to load resource: the server responded with a status of \d{3}/.test(message.text())) return;
    runtimeErrors.push(message.text());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!browserApiOrigins.has(url.origin)) return;
    const method = response.request().method();
    // The browser adopts the created session id from the create response
    // body; record it so its early navigation 404s can be correlated with
    // the exact benign pattern (the URL adoption below adds it again after
    // waitForURL, covering the race).
    if (method === "POST" && url.pathname === "/api/sessions" && response.status() < 300) {
      void response.json().then((body) => {
        if (body && typeof body.id === "string") createdSessionIds.add(body.id);
      }).catch(() => undefined);
    }
    // Exact non-ok accounting: benign tuples are tracked by method+pathname+
    // status; every other non-ok response is a runtime failure recorded
    // directly (console resource messages cannot be correlated — they lack
    // the URL).
    if (response.status() >= 400) {
      const benignKey = benignNonOkKey(method, url, response.status());
      if (benignKey) benignNonOk.add(benignKey);
      else runtimeErrors.push(`unexpected non-ok response: ${method} ${url.pathname}${url.search} -> ${response.status()}`);
    }
    if (url.pathname.startsWith("/api/sessions")) {
      sessionRuntimeChecks.push((async () => ({
        method: response.request().method(),
        path: url.pathname,
        runtime: await response.headerValue("x-pi-science-runtime"),
        sse: await response.headerValue("x-pi-science-sse"),
      }))());
    }
    // Exact navigation API surface only: the all-role index (messages/index)
    // is out of scope for these ownership checks.
    if (/^\/(api\/bookmarks|api\/attention|api\/sessions\/[^/]+\/read-state|api\/sessions\/[^/]+\/messages)$/.test(url.pathname)) {
      navigationRuntimeChecks.push((async () => ({
        method: response.request().method(),
        path: url.pathname,
        runtime: await response.headerValue("x-pi-science-runtime"),
      }))());
    }
  });
  try {
    const route = `/workspace/${encodeURIComponent(workspace)}`;
    await page.goto(`${frontend}${route}`, { waitUntil: "domcontentloaded" });
    // Session creation is lazy: the workspace landing opens a blank composer
    // and the FIRST prompt creates the persisted session (the sidebar
    // "New conversation" action only returns to that landing).
    const modelTrigger = page.getByRole("button", { name: "Select model and thinking level and view context" });
    const hasConfiguredModel = typeof config.model === "string" && config.model.length > 0;
    const composer = page.getByPlaceholder(/Ask anything/);
    const modelTriggerReady = () => page.waitForFunction(() => {
      const trigger = Array.from(document.querySelectorAll("button")).find((button) => (button.getAttribute("aria-label") ?? "").startsWith("Select model"));
      return trigger instanceof HTMLButtonElement && !trigger.disabled;
    }, undefined, { timeout: 20_000 });
    let firstSession = null;
    let secondSession = null;
    let firstSettled = false;
    let secondConversationRan = false;
    if (hasConfiguredModel) {
      await modelTrigger.waitFor({ timeout: 20_000 });
      await modelTriggerReady();
      const selectedLabel = ((await modelTrigger.textContent()) ?? "").trim();
      if (!selectedLabel || /^(Select model|选择模型)$/.test(selectedLabel)) {
        throw new Error(`Composer did not pre-select a model: ${JSON.stringify(selectedLabel)}`);
      }
      await modelTrigger.click();
      await page.getByRole("menuitem").first().waitFor({ timeout: 10_000 });
      await page.keyboard.press("Escape");

      // First prompt lazily creates the first persisted session; the URL
      // adopts the new session id once the create/prompt ACK lands.
      await composer.fill("请先使用 bash 工具执行 sleep 2，然后只回复 CHAT_BROWSER_UAT_OK");
      await page.getByRole("button", { name: "Send message" }).click();
      await page.waitForURL(/\/session\//, { timeout: 60_000 });
      firstSession = sessionIdFromUrl(page.url());
      if (!firstSession) throw new Error(`No session ID after first prompt: ${page.url()}`);
      createdSessions.push(firstSession);
      createdSessionIds.add(firstSession);
      await page.getByRole("button", { name: "Stop generation" }).waitFor({ timeout: 10_000 });
      await page.getByText("Working…", { exact: true }).waitFor({ timeout: 10_000 });
      firstSettled = await waitForModelSettlement(page, "CHAT_BROWSER_UAT_OK", "first-prompt", sessionRuntimeChecks);
      if (!firstSettled) {
        // The model provider is flaky; node-control-plane ownership was
        // already proven by the first prompt (create/prompt/SSE), so the
        // second live-model conversation is skipped and the model-free
        // navigation fixture UAT runs next.
        console.log("SKIP live-model second conversation: the first prompt never settled (external model flake) and node-control-plane ownership is already proven — the navigation fixture UAT runs next");
      } else {
        await page.getByRole("button", { name: "Send message" }).waitFor({ timeout: 60_000 });
        secondConversationRan = true;

        // Second conversation: "New conversation" returns to the blank landing;
        // the next prompt creates a DIFFERENT persisted session id.
        await page.getByTitle("New conversation").click();
        await page.waitForFunction(() => !window.location.pathname.match(/\/session\/[^/]+$/), undefined, { timeout: 20_000 });
        // The landing's connect effect clears the previous session asynchronously;
        // the welcome h2 only renders once the thread is blank and ready (the
        // sidebar h1 logo is always present and must NOT be used as the signal),
        // so the next prompt is guaranteed to create a fresh session id.
        await page.locator("h2", { hasText: "Pi-Science" }).waitFor({ timeout: 20_000 });
        await modelTriggerReady();
        if (!((await modelTrigger.textContent()) ?? "").trim()) {
          throw new Error("New conversation did not restore a selected model");
        }
        await composer.fill("请只回复 CHAT_BROWSER_SECOND_OK");
        await page.getByRole("button", { name: "Send message" }).click();
        await page.waitForURL(/\/session\//, { timeout: 60_000 });
        secondSession = sessionIdFromUrl(page.url());
        if (!secondSession || secondSession === firstSession) {
          throw new Error(`New conversation reused the old ID: ${firstSession}`);
        }
        createdSessions.push(secondSession);
        createdSessionIds.add(secondSession);
        if (await waitForModelSettlement(page, "CHAT_BROWSER_SECOND_OK", "second-prompt", sessionRuntimeChecks)) {
          await page.getByRole("button", { name: "Send message" }).waitFor({ timeout: 60_000 });
        }
      }
    } else {
      await composer.fill("model configuration required");
      if (!(await page.getByRole("button", { name: "Send message" }).isDisabled())) {
        throw new Error("Send should be disabled when no provider/model is configured");
      }
      await composer.fill("");
    }
    await page.screenshot({ path: screenshot, fullPage: true });

    const observedSessions = await Promise.all(sessionRuntimeChecks);
    if (hasConfiguredModel) {
      if (!observedSessions.length) throw new Error("Browser did not make any session API requests");
      const wrongOwner = observedSessions.find((item) => item.runtime !== "node-control-plane");
      if (wrongOwner) throw new Error(`Session request escaped Node ownership: ${JSON.stringify(wrongOwner)}`);
      if (!observedSessions.some((item) => item.method === "POST" && item.path === "/api/sessions")) {
        throw new Error("Browser did not create a session through the Node API");
      }
      if (!observedSessions.some((item) => item.method === "POST" && item.path.endsWith("/prompt"))) {
        throw new Error("Browser did not send its prompt through the Node API");
      }
      const eventStream = observedSessions.find((item) => item.path.endsWith("/events"));
      if (!eventStream) throw new Error("Browser did not connect to the session SSE endpoint");
      if (eventStream.sse !== "node-native") {
        throw new Error(`Expected node-native SSE, got ${eventStream.sse || "missing header"}`);
      }
    }
    if (runtimeErrors.length) throw new Error(`Browser runtime errors:\n${runtimeErrors.join("\n")}`);
    console.log("PASS workspace marker accepted by Node workspace security");
    if (hasConfiguredModel) {
      console.log("PASS browser session create/prompt/SSE responses were owned by node-control-plane");
      console.log("PASS browser SSE response reported node-native");
      console.log(`PASS composer selected configured model ${config.model}`);
      if (firstSettled) console.log("PASS first prompt showed stop/working state and settled with streamed text");
      if (secondConversationRan) console.log(`PASS new conversation changed ID ${firstSession} -> ${secondSession}`);
    } else {
      console.log("PASS composer clearly disabled sending because no provider/model is configured");
      console.log("SKIP live-session ownership checks: configure a model to run the prompt/SSE branch (covered by smoke:real-pi)");
    }

    // Durable navigation coverage (model-free; runs after the live-session
    // flow so the fixture workspace stays empty until the UI flow is done).
    // Browser activation lets the Pi runtime canonicalize the transcript with
    // its own message ids; when that is unavailable the fixture keeps its
    // hand-written ids and the Node API checks still run (the browser fixture
    // phase is SKIPped). All assertions key off the stable message texts.
    await writeFixtureSession();
    // The browser fixture phase is REQUIRED whenever the Pi runtime is
    // available: canonicalizing the fixture transcript proves the runtime
    // took ownership of the session. Detect runtime availability explicitly
    // BEFORE the fixture — the SKIP branch below is only legal when the
    // runtime was already known to be unavailable. With a configured model
    // the live-session flow above already proved the runtime works; without
    // one, probe the control plane by creating a throwaway session.
    const runtimeAvailable = hasConfiguredModel || await detectRuntimeAvailability();
    const { fixture, canonicalized } = await primeFixtureSession(page);
    if (!canonicalized && runtimeAvailable) {
      throw new Error("fixture transcript was not canonicalized within 90s although the Pi runtime is available — the browser fixture navigation UAT must not be skipped");
    }
    if (canonicalized) {
      // The activation page parked at the bottom; its debounced read-state
      // writes can land after the file canonicalization, so wait for them to
      // settle BEFORE the API phase's baseline reset.
      await waitForActivationReadStateSettle();
    } else {
      console.log("SKIP browser fixture navigation UAT: the Pi runtime is unavailable (detected before the fixture) — Node API navigation checks still ran");
    }
    await runNavigationApiUat(fixture);
    if (canonicalized) {
      await runNavigationBrowserUat(page, fixture, navigationRuntimeChecks);
    }
    // Browser-console cleanliness is only meaningful when the browser fixture
    // phase actually ran: without canonicalization the fixture page can
    // legitimately surface degraded-mode errors from the missing runtime.
    if (canonicalized && runtimeErrors.length) throw new Error(`Browser runtime errors:\n${runtimeErrors.join("\n")}`);
    console.log(`SCREENSHOT ${screenshot}`);
  } finally {
    await browser.close();
    const query = new URLSearchParams({ cwd: workspace });
    for (const sessionId of [...createdSessions, fixtureSessionId]) {
      await fetch(`${backend}/api/sessions/${encodeURIComponent(sessionId)}?${query}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
    await rm(workspace, { recursive: true, force: true });
  }
}


run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
