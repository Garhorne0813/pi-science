import { useTranslation } from "react-i18next";

// Shared tabular preview: first row of data is the header (csv and xlsx alike).
export interface TableData {
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

export function TablePreview({ table }: { table: TableData }) {
  const { t } = useTranslation();
  const numeric = table.columns.map((_, index) => {
    const values = table.rows.map((row) => row[index]?.trim()).filter(Boolean);
    return values.length > 0 && values.every((value) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value!));
  });
  return (
    <div className="min-w-full bg-surface">
      <table className="w-max min-w-full border-collapse text-ui-caption tabular-nums">
        <thead>
          <tr className="sticky top-0 border-b border-border bg-surface-2 text-left text-muted">
            {table.columns.map((c, i) => (
              <th key={i} className={`whitespace-nowrap px-3 py-2 font-medium ${numeric[i] ? "text-right" : "text-left"}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0 hover:bg-surface-hover">
              {row.map((cell, j) => (
                <td key={j} className={`whitespace-nowrap px-3 py-1.5 text-text ${numeric[j] ? "text-right font-mono" : "text-left"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.truncated && (
        <div role="status" className="sticky bottom-0 border-t border-border bg-surface-2 px-3 py-2 text-ui-caption text-muted">
          {t("table.showingFirstRows", { count: table.rows.length })}
        </div>
      )}
    </div>
  );
}
