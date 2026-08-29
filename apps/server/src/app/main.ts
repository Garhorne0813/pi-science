import { launchServer, openSystemBrowser, type LaunchedServer } from "../launcher/launcher.js";

let server: LaunchedServer | undefined;
let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  console.log(`Received ${reason}; shutting down Pi-Science control plane`);
  await server?.close();
}

function fatal(reason: string, error: unknown): void {
  console.error(`${reason}:`, error);
  process.exitCode = 1;
  void shutdown(reason, 1).catch((shutdownError: unknown) => {
    console.error("Failed to shut down Pi-Science control plane:", shutdownError);
    process.exitCode = 1;
  });
}

process.once("unhandledRejection", (reason) => fatal("Unhandled promise rejection", reason));
process.once("uncaughtException", (error) => fatal("Uncaught exception", error));
process.once("SIGINT", () => { void shutdown("SIGINT").catch((error) => fatal("SIGINT shutdown failure", error)); });
process.once("SIGTERM", () => { void shutdown("SIGTERM").catch((error) => fatal("SIGTERM shutdown failure", error)); });

try {
  server = await launchServer({
    log: (message) => console.log(message),
    openBrowser: process.env.PI_SCIENCE_OPEN_BROWSER === "1" ? (url) => openSystemBrowser(url) : undefined,
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
