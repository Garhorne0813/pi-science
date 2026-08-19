import { launchServer, openSystemBrowser } from "../launcher/launcher.js";

try {
  const server = await launchServer({
    log: (message) => console.log(message),
    openBrowser: process.env.PI_SCIENCE_OPEN_BROWSER === "1" ? (url) => openSystemBrowser(url) : undefined,
  });

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down Pi-Science control plane`);
    await server.close();
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
