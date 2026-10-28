import { exportLegacyMemory } from "../memory/legacy-export.js";
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error(
    "Usage: pnpm export:legacy-memory /absolute/workspace /absolute/new-export.json\nStop Pi-Science for a stable legacy-file snapshot. Originals are retained; export does not import or approve records.",
  );
  process.exitCode = 2;
} else
  await exportLegacyMemory(args[0]!, args[1]!)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
