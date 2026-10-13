# Kernel isolation

Persistent Python and R kernels execute cell code with the privileges of the user who runs the
server. The control plane confines each kernel to its workspace with an OS profile. macOS enforces
the profile with Seatbelt. Every other platform refuses to start a kernel under the default policy.

The policy is a kernel-start decision. A cell request cannot change it.

## Policy

`PI_SCIENCE_KERNEL_ISOLATION` selects one of three policies. Each value is a complete permission set,
so no two settings can disagree. The default is `workspace`. An invalid value fails server startup.

| Value | Filesystem | Network |
| --- | --- | --- |
| `workspace` (default) | Read and write the workspace and a private scratch directory. Read the language runtime, the bridge files, and the system libraries. Deny everything else. | Deny, including sockets opened by a subprocess a cell starts. |
| `workspace-network` | The same filesystem policy as `workspace`. | Allow. |
| `unconfined` | No profile. The kernel runs with the privileges of the server process. | No profile. |

The server never selects `unconfined` on its own. It exists for the execution-mechanics tests and for
a host where the profile cannot be enforced.

## What the profile grants

Read access:

- The workspace. The workspace's own `.pi-science` directory is subtracted from it again.
- The environment prefix that owns the interpreter, read-only.
- The interpreter's real installation tree, read-only. A prefix whose `bin/python` is a symlink needs
  the tree of the target, not the prefix.
- `/opt/homebrew/Cellar`, `/opt/homebrew/opt`, and `/opt/homebrew/lib` read-only when the interpreter
  lives under `/opt/homebrew`, or the equivalent under `/usr/local`. A Homebrew interpreter loads
  extension modules from sibling formulae, so `import ssl` fails without them. A micromamba prefix is
  self-contained and needs no such rule.
- The bridge script, and the R bridge's per-cell code file, by exact path.
- The scratch directory, under the app state root at `kernel-scratch/<session>`.
- The system trees `/usr/lib`, `/usr/share`, `/System`, `/Library`, and `/private/var/db`.

Write access:

- The workspace.
- The scratch directory.
- `/dev/null` and `/dev/dtracehelper`.

The read set also holds the literal root path, which the dynamic loader needs.

`/dev/null` matters because a program opens it for writing, and `subprocess.DEVNULL` does exactly
that. The profile also carries the Mach and POSIX shared-memory permits that CPython needs at start.

## What the profile denies

- The app state root, in full. Execution records, provenance, session state, and the micromamba store
  are not readable and not writable from a cell, except for the one environment prefix the kernel
  runs from.
- `<workspace>/.pi-science`, read and write.
- Writes to the environment prefix, the interpreter tree, and the bridge files. Package installation
  belongs to the packages API, and the server already treats a direct `pip install` into the prefix
  as an out-of-band mutation.
- Network sockets, under the `workspace` policy.
- `$HOME`, the user's other projects, and every path outside the lists above.

`file-read-metadata` stays global, so a cell can stat a path and learn that it exists. It cannot read
its contents. This is a deliberate, bounded exposure: path traversal needs metadata on the ancestors
of the paths the profile allows.

## Platform support

| Platform | Enforced |
| --- | --- |
| darwin | Yes, with `/usr/bin/sandbox-exec`. |
| linux | No. The kernel is refused. |
| win32 | No. The kernel is refused. |

Linux and Windows refuse rather than fall back, because an unverified sandbox reports protection it
does not provide. The refusal names the platform, the reason, and the exact escape hatch:

```
Kernel isolation policy "workspace" cannot be enforced on linux: no OS enforcer is available. No kernel was started. Set PI_SCIENCE_KERNEL_ISOLATION=unconfined to run kernels without OS isolation, or run the server on macOS, where the profile is enforced.
```

A macOS host without an executable `/usr/bin/sandbox-exec` produces the same refusal with
`/usr/bin/sandbox-exec is missing or not executable` as the reason.

The message reaches the notebook as the cell's error, and the execution record keeps it. Neither
execute route needed a new branch, because both already report a thrown error.

## Credentials in the cell environment

The kernel environment comes from `workspaceEnvironmentVariables()`, which copies the server's own
environment. The isolation seam removes the server's credentials from it before the spawn:

- the exact key `PI_SCIENCE_INTERNAL_TOKEN`, which `scripts/start.sh` exports, and
- any key whose uppercase form ends in `_API_KEY`, `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, or
  `_PRIVATE_KEY`.

Everything else is kept, so a cell still sees `PATH`, the locale, and an operator variable such as
`R_LIBS` or `HF_HOME`. Two limits apply. `unconfined` removes nothing and leaves the environment as
it is. The rule matches names, so a credential the operator registered under an unusual name can
still reach a cell. The key that grants control-plane access is removed by exact name.

The seam points five variables at the scratch directory: `TMPDIR`, `TMP`, `TEMP`, `MPLCONFIGDIR`,
and `XDG_CACHE_HOME`. It does not rewrite `HOME`, so a write to `~` fails
loudly instead of landing in a directory that the kernel deletes when it stops.

## Workflows that need an exception

- Install a package. Use the packages API. A cell cannot write to its own environment prefix.
- Fetch data from the network. Set `PI_SCIENCE_KERNEL_ISOLATION=workspace-network` and restart the
  server. Filesystem confinement stays in place.
- Read a dataset that lives outside the workspace. Copy it into the workspace, or open its directory
  as a workspace. The workspace is the unit of trust.
- Write a file with `~` in the path. Write it into the workspace instead.
- Run a kernel on Linux or Windows. Set `PI_SCIENCE_KERNEL_ISOLATION=unconfined` and accept that
  cells run with the server's privileges.

## Known limits

- R enforcement is unverified. The development host has no `Rscript`, so only the Python path was
  measured against a real kernel. The R bridge gets the same profile plus read access to its per-cell
  code file.
- `/usr/bin/sandbox-exec` is deprecated by Apple. A host without it produces the same actionable
  refusal as an unsupported platform.
- The profile sets no resource limits. A cell can fork, and it can run any binary the profile lets it
  read.
- Shell and one-shot job sandboxing is a separate change and is not covered by this policy.
- The profile is fixed at kernel start. A policy change applies to the next kernel, not to a running
  one.
