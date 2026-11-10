# Tool progress

A tool call can show one live progress row in the conversation. The row appears
while the call runs and is replaced in place, so a ten minute job does not fill
the transcript with lines.

Two things are measured here and nothing else: a count of finished work, and the
size of the scope that count belongs to. A percentage is shown only when both
numbers came from the producer. Text such as `50%` in ordinary output is never
read as a measurement, because a percentage with no denominator cannot be
checked.

## What works with no change to the command

| Producer | Read from | Row |
| --- | --- | --- |
| `tqdm` / `trange` | the library's own `n/total` counter in its bar, on stderr | bar |
| `pv --format '%b/%s '` | bytes moved and total size | bar |
| `rsync --info=progress2` | `to-chk=remaining/total` from one record | count of files, no bar |
| `dd status=progress` | `N bytes copied`, which carries no total | count of bytes, no bar |
| anything that writes a control record | see below | depends on the record |

Two sources deliberately show less than they could. `pv` without a machine
format prints a percentage and no denominator, so it reports nothing. `rsync`
re-estimates its total while it runs, so the row counts files and does not claim
a stable bar.

## What needs one line in the script

A library that only prints a percentage cannot be turned back into a count, so
it reports through a helper instead. Each helper is opt-in, is scoped to the
process that calls it, and can be switched off.

| Library | Helper |
| --- | --- |
| `rich.progress.Progress` / `track` | `from pi_progress import enable_rich; enable_rich()` |
| any Python loop | `from pi_progress import bar; for item in bar(items, total=len(items)):` |
| any R loop | `source("pi_progress.R"); step <- pi_progress_bar(10, "Items"); step()` |
| any shell program | `./pi-progress --current 3 --total 10 --label "Scanning"` |

`enable_rich()` patches `Progress.refresh` once, reads `task.completed`,
`task.total` and `task.description`, and `disable_rich()` restores the original
method. Nothing is patched unless a script asks for it, so importing these files
does not change how any other program behaves.

## The control record

Any program can report without a helper by writing one complete line to stdout
or stderr, starting at column zero:

```
<<pi-progress>> {"version":1,"scopeId":"scan:1","scopeLabel":"Scanning files","current":72,"total":100,"unit":"files","totalKind":"fixed"}
```

- The line must end with a newline and must be at most 512 bytes. A longer or
  unfinished line stays in the output as ordinary text.
- `scopeId` names the measured work inside this call. Two records with one id are
  two measurements of one thing, and a new scope starts its own count. A count
  that goes backwards inside one scope is treated as a repeated event and the
  higher value stays, until the scope reports its total. After that a lower count
  is the next pass of the same work and resets.
- `totalKind` is `fixed` only when the total will not change. `reestimated` and
  `unknown` show a count instead of a bar.
- The record is removed from the output the tool returns, so it never reaches
  the files, the logs or the artifact list.

## What is not covered

- Notebook and kernel cells, and Jupyter widgets.
- Two progress rows at once. One record describes one scope, so a second
  concurrent scope replaces the first rather than being added to it.
- Estimated completion times.
