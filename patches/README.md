# Maintained dependency patches

## @anthropic-ai/sandbox-runtime 0.0.79

`@anthropic-ai__sandbox-runtime@0.0.79.patch` changes the package's published
`dist/sandbox/macos-sandbox-utils.js`. It preserves explicitly allowed literal
child directories when restoring a parent deny after a broad workspace allow.
Independent sensitive-descendant denies still apply. See the
[policy description](../docs/universal-sandbox.md#skill-helper-resources) and
[acceptance workflow](../.github/workflows/sandbox-acceptance.yml).

Upstream status: no issue or PR is recorded in this repository. Record its URL
and status here when one is filed; do not assume this fix is upstream.

When upgrading this dependency:

1. Inspect upstream `lateReadDenyFilters` and compare the parent-deny/child-allow
   behavior against this patch. Remove the patch only if upstream preserves the
   same isolation semantics.
2. If still needed, regenerate it with `pnpm patch` / `pnpm patch-commit` against
   the new version. Update `pnpm-workspace.yaml` and the lockfile together; never
   copy the old patch onto changed code without inspection.
3. Run a frozen install, then the real Linux and macOS sandbox acceptance matrix,
   including Skill helper reads, sibling/descendant denial, literal glob-like
   paths, and the Skill resource benchmark. Mocked policy tests alone cannot
   establish Seatbelt behavior.
4. Update this record with the new version, upstream status and validation.

Keep maintenance metadata in this companion file so documentation-only changes
do not alter pnpm's patch hash.
