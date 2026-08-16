export function NotebookMimeOutput({ mime, label }: { mime: Record<string, string>; label: string }) {
  const png = mime["image/png"];
  const jpeg = mime["image/jpeg"];
  const svg = mime["image/svg+xml"];
  const html = mime["text/html"];
  const json = mime["application/json"];

  return (
    <div className="space-y-2">
      {(png || jpeg) && <img src={`data:${png ? "image/png" : "image/jpeg"};base64,${png || jpeg}`} alt={label} className="max-h-[520px] max-w-full rounded-input bg-white object-contain" />}
      {svg && <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={label} className="max-h-[520px] max-w-full rounded-input bg-white object-contain" />}
      {json && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-input bg-surface-2 p-3 font-mono text-xs leading-5 text-text">{prettyJson(json)}</pre>}
      {html && (
        <iframe
          title={label}
          sandbox=""
          srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"><style>body{margin:12px;color:#24231f;font:13px system-ui,sans-serif}table{border-collapse:collapse;width:100%}th,td{border:1px solid #dedbd2;padding:6px 8px;text-align:left}thead{background:#f3f1eb}</style>${html}`}
          className="h-64 w-full rounded-input border border-faint bg-white"
        />
      )}
    </div>
  );
}

function prettyJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}
