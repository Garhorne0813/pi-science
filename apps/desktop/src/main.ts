import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { fork, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { app, BrowserWindow, dialog, session, shell } from "electron";
import { desktopRunnerPath, desktopRuntimeRoot, frontendDistPath, piCliPath, serverLauncherPath } from "./runtime-paths.js";

const COOKIE_NAME = "pi_science_desktop";
const STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob: https:; object-src 'none'; base-uri 'self'; form-action 'self'";

let controlPlane: ChildProcess | undefined;
let controlPlaneOrigin: string | undefined;
let mainWindow: BrowserWindow | undefined;
let shutdownComplete = false;
let shutdownStarted = false;

if (process.env.PI_SCIENCE_DESKTOP_USER_DATA) app.setPath("userData", resolve(process.env.PI_SCIENCE_DESKTOP_USER_DATA));

function messagePayload(message: unknown): unknown {
  return message && typeof message === "object" && "data" in message ? (message as { data?: unknown }).data : message;
}

async function startControlPlane(): Promise<{ origin: string; token: string }> {
  const packaged = app.isPackaged;
  const root = desktopRuntimeRoot(packaged, process.resourcesPath, import.meta.url);
  const runner = desktopRunnerPath(packaged, root);
  const launcher = serverLauncherPath(packaged, root);
  const frontend = frontendDistPath(packaged, root);
  const cli = piCliPath(packaged, root);
  for (const [label, path] of [["desktop runner", runner], ["server launcher", launcher], ["frontend", frontend], ["Pi Orbit", cli]] as const) {
    if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  }

  const dataRoot = join(app.getPath("userData"), "data");
  const logRoot = join(app.getPath("userData"), "logs");
  await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(logRoot, { recursive: true })]);
  const token = randomBytes(32).toString("hex");
  const environment = {
    NODE_ENV: "production",
    PI_SCIENCE_HOME: dataRoot,
    PI_SCIENCE_WORKSPACES: process.env.PI_SCIENCE_DESKTOP_WORKSPACES || join(app.getPath("documents"), "Pi-Science"),
    PI_SCIENCE_PORT: "0",
    PI_SCIENCE_HOST: "127.0.0.1",
    PI_SCIENCE_FRONTEND_DIST: frontend,
    PI_SCIENCE_RESOURCE_ROOT: root,
    PI_SCIENCE_DESKTOP_TOKEN: token,
    PI_SCIENCE_SERVER_LAUNCHER: launcher,
    PI_CLI_PATH: cli,
    LOG_LEVEL: "info",
  };
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const child = fork(runner, [], {
    execPath: process.execPath,
    env: { ...inherited, ...environment, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  controlPlane = child;
  const log = createWriteStream(join(logRoot, "control-plane.log"), { flags: "a" });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("exit", (code) => reject(new Error(`Control plane utility process failed to spawn (exit ${code})`)));
  });

  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Control plane did not start within ${STARTUP_TIMEOUT_MS / 1000} seconds`)), STARTUP_TIMEOUT_MS);
    child.on("message", (event) => {
      const message = messagePayload(event) as { type?: unknown; url?: unknown; error?: unknown };
      if (message?.type === "ready" && typeof message.url === "string") {
        clearTimeout(timer);
        resolve(message.url);
      } else if (message?.type === "error") {
        clearTimeout(timer);
        reject(new Error(String(message.error ?? "Control plane failed")));
      }
    });
    child.once("exit", (code) => {
      if (!controlPlaneOrigin) {
        clearTimeout(timer);
        reject(new Error(`Control plane exited during startup with code ${code}`));
      }
    });
  });

  const origin = (await ready).replace(/\/$/, "");
  controlPlaneOrigin = origin;
  return { origin, token };
}

function secureSession(origin: string): void {
  const appSession = session.defaultSession;
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  appSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith(`${origin}/`)) return callback({ responseHeaders: details.responseHeaders });
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } });
  });
}

async function createWindow(origin: string, token: string): Promise<void> {
  secureSession(origin);
  if (token) await session.defaultSession.cookies.set({ url: origin, name: COOKIE_NAME, value: token, path: "/", httpOnly: true, secure: false, sameSite: "strict" });
  const window = new BrowserWindow({
    title: "Pi-Science",
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 720,
    show: false,
    backgroundColor: "#090b10",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { if (mainWindow === window) mainWindow = undefined; });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${origin}/`)) return;
    event.preventDefault();
    if (url.startsWith("https://")) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  await window.loadURL(origin);
}

async function stopControlPlane(): Promise<void> {
  if (!controlPlane) return;
  const child = controlPlane;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    const timer = setTimeout(() => { child.kill(); finish(); }, SHUTDOWN_TIMEOUT_MS);
    child.once("exit", () => { clearTimeout(timer); finish(); });
    child.send({ type: "shutdown" });
  });
  controlPlane = undefined;
  controlPlaneOrigin = undefined;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { if (mainWindow) mainWindow.show(); else if (controlPlaneOrigin) void createWindow(controlPlaneOrigin, ""); });
  app.on("before-quit", (event) => {
    if (shutdownComplete || shutdownStarted || !controlPlane) return;
    event.preventDefault();
    shutdownStarted = true;
    void stopControlPlane().finally(() => { shutdownComplete = true; app.quit(); });
  });
  void app.whenReady().then(async () => {
    const { origin, token } = await startControlPlane();
    if (process.env.PI_SCIENCE_DESKTOP_SMOKE === "1") {
      const headers = { cookie: `${COOKIE_NAME}=${token}` };
      let smokeWorkspace: string | undefined;
      try {
        const [ready, health] = await Promise.all([
          fetch(`${origin}/internal/ready`),
          fetch(`${origin}/api/health`, { headers }),
        ]);
        if (!ready.ok || !health.ok) throw new Error(`Desktop smoke failed: ready=${ready.status}, health=${health.status}`);
        const createdWorkspace = await fetch(`${origin}/api/workspaces`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ name: `.desktop-smoke-${process.pid}-${Date.now()}` }),
          signal: AbortSignal.timeout(30_000),
        });
        const workspace = await createdWorkspace.json() as { path?: unknown; error?: unknown };
        if (!createdWorkspace.ok || typeof workspace.path !== "string") throw new Error(`Desktop smoke workspace failed: ${String(workspace.error ?? createdWorkspace.status)}`);
        smokeWorkspace = workspace.path;
        const createdSession = await fetch(`${origin}/api/sessions`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ cwd: smokeWorkspace, config: {} }),
          signal: AbortSignal.timeout(120_000),
        });
        const sessionResult = await createdSession.json() as { id?: unknown; error?: unknown };
        if (!createdSession.ok || typeof sessionResult.id !== "string") throw new Error(`Desktop smoke session failed: ${String(sessionResult.error ?? createdSession.status)}`);
        console.log(`Desktop smoke passed at ${origin} (session ${sessionResult.id})`);
      } finally {
        await stopControlPlane();
        if (smokeWorkspace) await rm(smokeWorkspace, { recursive: true, force: true });
      }
      shutdownComplete = true;
      app.quit();
      return;
    }
    await createWindow(origin, token);
  }).catch((error) => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    if (process.env.PI_SCIENCE_DESKTOP_SMOKE === "1") console.error(detail);
    else dialog.showErrorBox("Pi-Science failed to start", detail);
    shutdownComplete = true;
    app.quit();
  });
}
