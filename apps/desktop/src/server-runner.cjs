const { pathToFileURL } = require("node:url");

const parentPort = process.parentPort;
if (!parentPort && !process.send) throw new Error("Pi-Science desktop server runner requires a parent process channel");

function send(message) {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

let server;
let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  await server?.close();
  send({ type: "stopped" });
  process.exit(0);
}

function handleMessage(message) {
  if (message?.type !== "shutdown") return;
  void shutdown().catch((error) => {
    send({ type: "error", error: error instanceof Error ? error.stack ?? error.message : String(error) });
    process.exitCode = 1;
  });
}

if (parentPort) parentPort.on("message", (event) => handleMessage(event?.data));
else process.on("message", handleMessage);

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

void (async () => {
  const serverLauncher = process.env.PI_SCIENCE_SERVER_LAUNCHER;
  if (!serverLauncher) throw new Error("PI_SCIENCE_SERVER_LAUNCHER is not configured");
  const module = await import(pathToFileURL(serverLauncher).href);
  server = await module.launchServer();
  send({ type: "ready", url: server.url });
})().catch((error) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(detail);
  send({ type: "error", error: detail });
  setTimeout(() => process.exit(1), 25);
});
