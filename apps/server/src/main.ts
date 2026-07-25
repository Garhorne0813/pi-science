import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp(config);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down Pi-Science control plane");
  await app.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ pythonOrigin: config.pythonOrigin, managedScientificRuntime: config.manageScientificRuntime }, "Pi-Science Node control plane started");
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
