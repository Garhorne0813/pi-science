import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root containing runtime/, harness/, and skills/.
 *
 * Source checkouts can derive it from this module's location. Packaged
 * desktop builds deploy the server under desktop-runtime/server, where that
 * relative layout no longer points at desktop-runtime, so the Electron host
 * supplies the explicit resource root instead.
 */
export function resourceRoot(): string {
  const configured = process.env.PI_SCIENCE_RESOURCE_ROOT?.trim();
  return configured
    ? resolve(configured)
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}
