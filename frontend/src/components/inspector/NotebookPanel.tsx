import { useState, useCallback, useEffect } from "react";
import { kernelShutdownUrl } from "../notebook/notebook-model";

interface CellResult {
  ok: boolean;
  stdout: string;
  result: string | null;
  error: string | null;
}

interface Cell {
  id: string;
  code: string;
  language: "python" | "r";
  result: CellResult | null;
  running: boolean;
}

export function NotebookPanel({ onClose, cwd, notebookId: requestedNotebookId }: { onClose: () => void; cwd?: string; notebookId?: string }) {
  const [notebookId] = useState(() => requestedNotebookId || `nb-${Date.now()}`);
  const [cells, setCells] = useState<Cell[]>([]);
  const [interpreters, setInterpreters] = useState<{ python: boolean; r: boolean } | null>(null);

  // Check kernel availability on mount
  useEffect(() => {
    fetch("/api/kernels/status")
      .then((r) => r.json())
      .then((d) => {
        setInterpreters({
          python: Boolean(d.interpreters?.python),
          r: Boolean(d.interpreters?.r),
        });
      })
      .catch(() => setInterpreters({ python: false, r: false }));
  }, []);

  useEffect(() => () => {
    void fetch(kernelShutdownUrl(notebookId, cwd || "."), {
      method: "POST",
    }).catch(() => undefined);
  }, [cwd, notebookId]);

  const addCell = useCallback((language: "python" | "r") => {
    if (!interpreters?.[language]) return;
    const cell: Cell = {
      id: `cell-${Date.now()}`,
      code: "",
      language,
      result: null,
      running: false,
    };
    setCells((prev) => [...prev, cell]);
  }, [interpreters]);

  const runCell = useCallback(async (cellId: string) => {
    setCells((prev) =>
      prev.map((c) => (c.id === cellId ? { ...c, running: true, result: null } : c))
    );

    const cell = cells.find((c) => c.id === cellId);
    if (!cell) return;

    try {
      const params = new URLSearchParams({ cwd: cwd || "." });
      const res = await fetch(`/api/kernels/execute?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: cell.language,
          code: cell.code,
          notebook_id: notebookId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Cell execution failed: ${res.statusText}`);
      setCells((prev) =>
        prev.map((c) => (c.id === cellId ? { ...c, running: false, result: data as CellResult } : c))
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setCells((prev) =>
        prev.map((c) =>
          c.id === cellId
            ? { ...c, running: false, result: { ok: false, stdout: "", result: null, error: message } }
            : c
        )
      );
    }
  }, [cells, notebookId, cwd]);

  const updateCellCode = useCallback((cellId: string, code: string) => {
    setCells((prev) =>
      prev.map((c) => (c.id === cellId ? { ...c, code } : c))
    );
  }, []);

  const removeCell = useCallback((cellId: string) => {
    setCells((prev) => prev.filter((c) => c.id !== cellId));
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", borderBottom: "1px solid var(--border)",
        backgroundColor: "var(--surface)",
      }}>
        <div>
          <span style={{ fontSize: "14px", fontWeight: 600 }}>Notebook</span>
          <span style={{
            fontSize: "11px", marginLeft: "8px", padding: "2px 8px", borderRadius: "8px",
            backgroundColor: interpreters === null ? "var(--warn)" : interpreters.python || interpreters.r ? "var(--ok)" : "var(--error)",
            color: "#fff",
          }}>
            {interpreters === null
              ? "Checking..."
              : interpreters.python || interpreters.r
                ? `${interpreters.python ? "Python" : ""}${interpreters.python && interpreters.r ? " / " : ""}${interpreters.r ? "R" : ""} Ready`
                : "No Kernel"}
          </span>
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          <button disabled={!interpreters?.python} onClick={() => addCell("python")} style={{ ...btnStyle("var(--accent)"), opacity: interpreters?.python ? 1 : 0.4 }}>+ Python</button>
          <button disabled={!interpreters?.r} onClick={() => addCell("r")} style={{ ...btnStyle("var(--ok)"), opacity: interpreters?.r ? 1 : 0.4 }}>+ R</button>
          <button onClick={onClose} style={{ ...btnStyle("var(--muted)"), fontSize: "16px" }}>✕</button>
        </div>
      </div>

      {/* Cells */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
        {cells.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 0", color: "var(--muted)", fontSize: "14px" }}>
            <p>No cells yet. Add a Python or R cell to get started.</p>
            <p style={{ fontSize: "12px", marginTop: "8px" }}>
              Cells within this notebook share a persistent namespace.
            </p>
          </div>
        )}
        {cells.map((cell) => (
          <div key={cell.id} style={{
            marginBottom: "12px",
            borderRadius: "8px",
            border: "1px solid var(--border-faint)",
            backgroundColor: "var(--surface)",
            overflow: "hidden",
          }}>
            {/* Cell header */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "6px 12px",
              backgroundColor: "var(--surface-2)",
              borderBottom: "1px solid var(--border-faint)",
            }}>
              <span style={{ fontSize: "11px", color: "var(--muted)", fontWeight: 500 }}>
                {cell.language.toUpperCase()} Cell
              </span>
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  onClick={() => runCell(cell.id)}
                  disabled={cell.running || !cell.code.trim()}
                  style={{
                    ...btnStyle("var(--ok)"),
                    opacity: cell.running || !cell.code.trim() ? 0.5 : 1,
                    fontSize: "11px", padding: "2px 10px",
                  }}
                >
                  {cell.running ? "Running..." : "▶ Run"}
                </button>
                <button onClick={() => removeCell(cell.id)} style={{ ...btnStyle("transparent"), fontSize: "11px", color: "var(--muted)" }}>
                  ✕
                </button>
              </div>
            </div>

            {/* Code editor */}
            <textarea
              value={cell.code}
              onChange={(e) => updateCellCode(cell.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  runCell(cell.id);
                }
              }}
              placeholder={cell.language === "python" ? "print('hello')" : "print('hello')"}
              rows={Math.max(2, cell.code.split("\n").length)}
              style={{
                width: "100%", resize: "vertical",
                padding: "10px 12px", border: "none",
                backgroundColor: "var(--surface)",
                color: "var(--text)", fontSize: "13px",
                fontFamily: "var(--font-mono)", lineHeight: "1.5",
                outline: "none",
              }}
            />

            {/* Result */}
            {cell.result && (
              <div style={{ borderTop: "1px solid var(--border-faint)", padding: "10px 12px" }}>
                {cell.result.stdout && (
                  <pre style={{
                    margin: 0, fontSize: "12px", fontFamily: "var(--font-mono)",
                    color: "var(--text)", whiteSpace: "pre-wrap",
                    maxHeight: "200px", overflowY: "auto",
                  }}>
                    {cell.result.stdout}
                  </pre>
                )}
                {cell.result.result && (
                  <div style={{
                    marginTop: cell.result.stdout ? "6px" : 0, fontSize: "13px",
                    fontFamily: "var(--font-mono)", color: "var(--accent)",
                    padding: "4px 8px", backgroundColor: "var(--surface-2)",
                    borderRadius: "4px",
                  }}>
                    {cell.result.result}
                  </div>
                )}
                {cell.result.error && (
                  <pre style={{
                    margin: 0, fontSize: "12px", fontFamily: "var(--font-mono)",
                    color: "var(--error)", whiteSpace: "pre-wrap",
                    padding: "8px", backgroundColor: "#fef2f2",
                    borderRadius: "4px",
                  }}>
                    {cell.result.error}
                  </pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer hint */}
      <div style={{
        padding: "8px 16px", borderTop: "1px solid var(--border-faint)",
        fontSize: "11px", color: "var(--muted)", textAlign: "center",
      }}>
        Ctrl+Enter to run cell · Notebook ID: {notebookId}
      </div>
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: "4px 12px",
    borderRadius: "6px",
    border: "1px solid var(--border-faint)",
    backgroundColor: bg,
    color: bg === "transparent" ? "var(--text)" : "#fff",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
  };
}
