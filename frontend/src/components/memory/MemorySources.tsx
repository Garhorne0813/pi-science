import { useState, useRef, useEffect } from "react";
import { MemoryDialog } from "./MemoryDialog";
import { memoryRequest } from "../../lib/memory";
import type { MemoryContent, MemoryRecord } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../lib/ui";
export function MemorySources({
  sources,
  cwd,
  projectId,
  onOpen,
  showProject = false,
}: {
  sources: MemoryContent["sources"];
  cwd?: string;
  projectId?: string;
  onOpen?: () => void;
  showProject?: boolean;
}) {
  const { t } = useTranslation();
  const openInspector = useUiStore((s) => s.openInspector);
  const [reference, setReference] = useState<{
    source: MemoryContent["sources"][number];
    record?: MemoryRecord;
    error?: string;
  }>();
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const openMemory = async (source: MemoryContent["sources"][number]) => {
    const id = ++request.current;
    setReference({ source });
    try {
      const data = await memoryRequest<{ record: MemoryRecord }>(
        cwd ?? null,
        `/records/${encodeURIComponent(source.locator)}`,
      );
      if (request.current === id) setReference({ source, record: data.record });
    } catch (error) {
      if (request.current === id)
        setReference({ source, error: String(error) });
    }
  };
  if (!sources.length)
    return (
      <p className="text-ui-caption text-muted">{t("memory.noSources")}</p>
    );
  return (
    <>
      <ul className="space-y-2">
        {sources.map((s, index) => (
          <li
            key={index}
            className="min-w-0 rounded-input border border-faint bg-surface p-3 text-ui-caption"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted">
                {t(`memory.sourceType.${s.kind}`, { defaultValue: s.kind })}
              </span>
              <span className="min-w-0 flex-1 break-all font-medium">
                {s.locator}
              </span>
              {s.version && (
                <span className="shrink-0 text-muted">
                  {t("memory.version", { version: s.version })}
                </span>
              )}
            </div>
            {s.kind === "file" &&
              cwd &&
              projectId &&
              (!s.projectId || s.projectId === projectId) && (
                <button
                  type="button"
                  className="mt-2 min-h-8 text-link hover:underline"
                  onClick={() => {
                    onOpen?.();
                    openInspector({
                      variant: "file",
                      path: s.locator,
                      filename: s.locator.split(/[\\/]/).at(-1) ?? s.locator,
                      root: "workspace",
                      cwd,
                    });
                  }}
                >
                  {t("memory.openCurrentFile")}
                </button>
              )}
            {cwd &&
              projectId &&
              (!s.projectId || s.projectId === projectId) &&
              (s.kind === "session" ||
                (s.kind === "message" && s.locator.includes("@"))) && (
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex min-h-8 items-center text-link hover:underline"
                  href={`/workspace/${encodeURIComponent(cwd)}/session/${encodeURIComponent(s.kind === "session" ? s.locator : s.locator.slice(0, s.locator.lastIndexOf("@")))}`}
                >
                  {t("memory.openSourceSession")}
                </a>
              )}
            {cwd &&
              projectId &&
              (!s.projectId || s.projectId === projectId) &&
              s.kind === "memory" && (
                <button
                  type="button"
                  className="mt-2 min-h-8 text-link hover:underline"
                  onClick={() => void openMemory(s)}
                >
                  {t("memory.openSourceMemory")}
                </button>
              )}
            {showProject && s.projectId && (
              <p className="mt-2 break-all text-muted">
                {t("memory.sourceField.projectId")}: {s.projectId}
              </p>
            )}
            {s.digest && (
              <p className="mt-2 break-all text-muted">
                {t("memory.sourceDigest")}:{" "}
                <code>
                  {s.digest.length > 12
                    ? s.digest.slice(0, 12) + "…"
                    : s.digest}
                </code>
              </p>
            )}
            <details className="mt-2 text-muted">
              <summary className="cursor-pointer text-ui-caption">
                {t("memory.referenceDetails")}
              </summary>
              <dl className="mt-2 space-y-1 break-all">
                {Object.entries(s).map(([key, value]) => (
                  <div key={key}>
                    <dt className="inline font-medium">
                      {t(`memory.sourceField.${key}`, { defaultValue: key })}
                      :{" "}
                    </dt>
                    <dd className="inline select-text">{value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </li>
        ))}
      </ul>
      {reference && (
        <MemoryDialog
          title={t("memory.openSourceMemory")}
          close={() => {
            request.current++;
            setReference(undefined);
          }}
        >
          {reference.error ? (
            <p role="alert" className="text-ui-label text-error-text">
              {reference.error}
            </p>
          ) : reference.record ? (
            <div className="space-y-4">
              <h3 className="text-ui-body font-semibold">
                {reference.record.title}
              </h3>
              <p className="text-ui-caption text-muted">
                {t("memory.version", { version: reference.record.revision })} ·{" "}
                {t(`memory.statusLabel.${reference.record.status}`)}
              </p>
              {((reference.source.version &&
                reference.source.version !==
                  String(reference.record.revision)) ||
                (reference.source.digest &&
                  reference.source.digest !==
                    reference.record.contentHash)) && (
                <p
                  role="alert"
                  className="rounded-input bg-warn-fill/10 p-3 text-ui-label text-warn-text"
                >
                  {t("memory.referenceChanged")}
                </p>
              )}
              <p className="whitespace-pre-wrap break-words text-ui-label leading-6">
                {reference.record.body}
              </p>
            </div>
          ) : (
            <p role="status">{t("common.loading")}</p>
          )}
        </MemoryDialog>
      )}
    </>
  );
}
