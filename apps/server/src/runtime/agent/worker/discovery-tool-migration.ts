import { laneConfig, laneState, setValue, value, type Session } from "@earendil-works/pi-agent-core/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";

export const discoveryToolsVersion = value<number>("pi-science", "discovery-tools-version");
/** Commit selection and version together. Recovery defers migration until idle. */
export async function migrateDiscoveryTools(session: Session, available: ReadonlySet<string>, eligible: boolean) {
  if (!eligible) return;
  await session.mutate(async (mutator, context) => {
    if ((await mutator.getValue(discoveryToolsVersion, context))?.value === 1) return;
    if ((await mutator.getValue(laneState("main"), context))?.value.currentOperationId) return;
    const config = (await mutator.getValue(laneConfig("main"), context))?.value;
    if (!config) return;
    const names = new Set(config.activeToolNames);
    // An intentionally disabled read tool does not opt in to discovery.
    if (names.has("read")) for (const name of ["ls", "glob", "grep"]) if (available.has(name)) names.add(name);
    await mutator.commit([setValue(laneConfig("main"), { ...config, activeToolNames: [...names] }), setValue(discoveryToolsVersion, 1)], context);
  }, BACKGROUND_CONTEXT);
}
