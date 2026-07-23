import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp(config);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ pythonOrigin: config.pythonOrigin }, "Pi-Science Node control plane started");
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
