import type { FileOperation } from "../../lib/knowledge";

export function OperationList({ operations }: { operations: FileOperation[] }) {
  return (
    <div className="space-y-2 font-mono text-[12px] leading-5">
      {operations.map((operation, index) => (
        <div key={`${operation.type}-${index}`}>
          {operation.type === "mkdir" ? (
            <span className="text-ok-text">+ mkdir {operation.target}</span>
          ) : (
            <>
              <div className="text-error-text">- {operation.source}</div>
              <div className="text-ok-text">+ {operation.target}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
