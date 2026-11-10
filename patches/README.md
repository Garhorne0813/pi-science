# Maintained dependency patches

## @anthropic-ai/sandbox-runtime 0.0.79

`@anthropic-ai__sandbox-runtime@0.0.79.patch` changes the package's published
`dist/sandbox/macos-sandbox-utils.js`. It does two things.

1. It preserves explicitly allowed literal child directories when restoring a
   parent deny after a broad workspace allow. Independent sensitive-descendant
   denies still apply. See the
   [policy description](../docs/universal-sandbox.md#skill-helper-resources) and
   [acceptance workflow](../.github/workflows/sandbox-acceptance.yml).
2. It emits `(allow file-read-metadata (literal …))` for the symlink components
   of an allowed path, after the existing directory-metadata allow. Seatbelt
   treats a link as neither a file nor a directory, so without this the loader
   cannot traverse `opt/<formula>` into a Homebrew Cellar. Each link is named
   twice: the spelling the caller wrote, and the one its parent resolves to,
   because Seatbelt reports the second for a link whose earlier components are
   themselves links (a versioned `libX.9.dylib -> libX.9.1.dylib` reached through
   `opt/<formula>/lib`). Literal filters keep the target's contents behind the
   read denies. See
   [macOS runtime dependency reads](../docs/universal-sandbox.md#macos-runtime-dependency-reads).

Upstream status: no issue or PR is recorded in this repository. Record its URL
and status here when one is filed; do not assume either hunk is upstream.

When upgrading this dependency:

1. Inspect upstream `lateReadDenyFilters` and compare the parent-deny/child-allow
   behavior against the first hunk. Inspect `generateReadRules` and
   `symlinkComponents` and compare the metadata rules against the second. Remove a
   hunk only if upstream preserves the same isolation semantics.
2. If still needed, regenerate it with `pnpm patch` / `pnpm patch-commit` against
   the new version. Update `pnpm-workspace.yaml` and the lockfile together; never
   copy the old patch onto changed code without inspection.
3. Run a frozen install, then the real Linux and macOS sandbox acceptance matrix,
   including Skill helper reads, sibling/descendant denial, literal glob-like
   paths, the Homebrew-shaped dylib regression and the Skill resource benchmark.
   Mocked policy tests alone cannot establish Seatbelt behavior.
4. Update this record with the new version, upstream status and validation.

Keep maintenance metadata in this companion file so documentation-only changes
do not alter pnpm's patch hash.
