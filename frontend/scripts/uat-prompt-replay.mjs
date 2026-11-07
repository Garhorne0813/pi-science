/**
 * Regression test for the "refresh during the lazy session-create round trip"
 * loss: send a prompt on a blank workspace landing, reload while
 * `POST /api/sessions` is still in flight, and assert the prompt survives,
 * is delivered exactly once, and does not leave an orphan empty session.
 *
 * The create request is delayed in the browser, so the refresh lands squarely
 * inside the window that used to lose the message.
 */
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "./browser-executable.mjs";

const frontend = process.env.PI_SCIENCE_FRONTEND_URL || "http://127.0.0.1:5173";
const backend = process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787";
const workspace = process.env.PI_SCIENCE_REPLAY_WORKSPACE;
const CREATE_DELAY_MS = Number(process.env.PI_SCIENCE_REPLAY_CREATE_DELAY_MS || 15_000);
const TEXT = `REPLAY_AFTER_REFRESH_${Date.now()}`;
const chromePath = await resolveBrowserExecutable();

if (!workspace) throw new Error("PI_SCIENCE_REPLAY_WORKSPACE must name an already-provisioned workspace");

async function api(path) {
  const response = await fetch(`${backend}${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function waitFor(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function sessionIdFromUrl(url) {
  const match = /\/session\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

const cwdQuery = `?cwd=${encodeURIComponent(workspace)}`;
const asList = (payload) => (Array.isArray(payload) ? payload : payload?.sessions ?? []);
const sessionsBefore = asList(await api(`/api/sessions${cwdQuery}`));
const beforeIds = new Set(sessionsBefore.map((session) => session.id));

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
const pageErrors = [];
const consoleErrors = [];
const promptPosts = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("request", (request) => {
  const url = new URL(request.url());
  if (request.method() === "POST" && /\/api\/sessions\/[^/]+\/prompt$/.test(url.pathname)) promptPosts.push(request.postData() ?? "");
});

try {
  // Hold every session-create response for longer than the reload window below.
  await page.route("**/api/sessions", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "POST" || url.pathname !== "/api/sessions") return route.continue();
    await new Promise((resolve) => setTimeout(resolve, CREATE_DELAY_MS));
    return route.continue();
  });

  await page.goto(`${frontend}/workspace/${encodeURIComponent(workspace)}`, { waitUntil: "domcontentloaded" });
  // Let the workspace session list settle first: on a workspace with history the
  // app may auto-open the newest session a moment after load. Then pin an
  // explicit blank landing, whose history state also survives the reload below
  // and keeps the app from auto-navigating away after it.
  await page.waitForTimeout(3_000);
  await page.getByTitle("New conversation").click();
  await page.waitForFunction(() => !/\/session\//.test(window.location.pathname), undefined, { timeout: 20_000 });
  if (sessionIdFromUrl(page.url())) throw new Error(`Could not reach the blank landing: ${page.url()}`);
  const composer = page.getByPlaceholder(/Ask anything/);
  await composer.waitFor({ timeout: 20_000 });
  await composer.fill(TEXT);
  await page.getByRole("button", { name: "Send message" }).click();

  await page.waitForTimeout(2_000);
  if (sessionIdFromUrl(page.url())) throw new Error(`Session was created before the reload window: ${page.url()}`);
  await page.reload({ waitUntil: "domcontentloaded" });

  // Before the fix the prompt was gone at this point and this wait timed out.
  const replayed = page.getByText(TEXT, { exact: true }).first();
  await replayed.waitFor({ timeout: 90_000 });
  console.log("INFO prompt is visible after the refresh");

  // The replayed prompt reaches the server once the held create resolves; wait
  // for the session and the persisted message instead of assuming a fixed delay.
  const created = await waitFor(async () => {
    const after = asList(await api(`/api/sessions${cwdQuery}`));
    const fresh = after.filter((session) => !beforeIds.has(session.id));
    return fresh.length > 0 ? fresh : null;
  }, 60_000, "the replayed prompt never created a session");
  await page.waitForTimeout(4_000);
  const sessionsAfter = asList(await api(`/api/sessions${cwdQuery}`));
  const stillCreated = sessionsAfter.filter((session) => !beforeIds.has(session.id));
  if (created.length !== 1 || stillCreated.length !== 1) {
    throw new Error(`Expected exactly one new session, got ${stillCreated.length}: ${stillCreated.map((session) => session.id).join(", ")}`);
  }
  const messages = await waitFor(async () => {
    const payload = await api(`/api/sessions/${encodeURIComponent(created[0].id)}/messages${cwdQuery}`);
    const persisted = (payload.messages ?? []).filter((message) => message.role === "user");
    return persisted.length === 1 ? persisted : null;
  }, 30_000, "the replayed prompt was not persisted");
  if ((messages[0]?.content?.[0]?.text ?? "") !== TEXT) throw new Error("The persisted prompt text does not match what was typed");
  if (promptPosts.length !== 1) throw new Error(`Expected exactly one prompt POST, got ${promptPosts.length}`);

  // A replay that only paints the text on the landing page is not a recovery:
  // the user must end up on the conversation the prompt landed in.
  const opened = await waitFor(() => sessionIdFromUrl(page.url()), 60_000, `the replayed prompt never opened its conversation (url ${page.url()})`);
  if (opened !== created[0].id) throw new Error(`The page opened session ${opened}, not the replayed session ${created[0].id}`);

  console.log(`PASS session=${created[0].id} promptPosts=${promptPosts.length} messages=${messages.length} url=${new URL(page.url()).pathname}`);
} finally {
  await browser.close();
  if (pageErrors.length || consoleErrors.length) {
    console.log(`INFO pageErrors=${JSON.stringify(pageErrors)} consoleErrors=${JSON.stringify(consoleErrors.slice(0, 5))}`);
  }
}
