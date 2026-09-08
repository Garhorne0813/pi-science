// Node runs the workspace source entrypoint during smoke tests. Keep the
// extension explicit so Node can load the TypeScript contract module through
// its built-in type stripping while TypeScript still resolves the .ts source.
export * from "./mcp.ts";
