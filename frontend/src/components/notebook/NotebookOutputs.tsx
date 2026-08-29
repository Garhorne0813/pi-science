import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { outputText, type NotebookOutput } from "./notebook-model";
import { NotebookMimeOutput } from "./NotebookMimeOutput";

export function StoredOutputs({ outputs }: { outputs: NotebookOutput[] }) {
  const { t } = useTranslation();
  if (outputs.length === 0) return null;
  return (
    <div className="space-y-2 border-t border-faint px-4 py-3 font-mono text-xs leading-5">
      {outputs.map((output, index) => {
        const png = mimeValue(output, "image/png");
        const jpeg = mimeValue(output, "image/jpeg");
        const svg = mimeValue(output, "image/svg+xml");
        const html = mimeValue(output, "text/html");
        const json = mimeValue(output, "application/json");
        const rich = Boolean(png || jpeg || svg || html || json);
        const text = rich && output.output_type !== "error" ? "" : outputText(output);
        const mime = Object.fromEntries(Object.entries({ "image/png": png, "image/jpeg": jpeg, "image/svg+xml": svg, "text/html": html, "application/json": json }).filter((entry): entry is [string, string] => Boolean(entry[1])));
        return (
          <div key={index} className="space-y-2">
            {text && (
              <pre className={cn(
                "max-h-64 overflow-auto whitespace-pre-wrap",
                output.output_type === "error" ? "text-error-text" : "text-text",
              )}>
                {text}
              </pre>
            )}
            {rich && <NotebookMimeOutput mime={mime} label={t("notebook.output", { index: index + 1 })} />}
          </div>
        );
      })}
    </div>
  );
}

function mimeValue(output: NotebookOutput, mime: string): string {
  const value = output.data?.[mime];
  return Array.isArray(value) ? value.join("") : value || "";
}
