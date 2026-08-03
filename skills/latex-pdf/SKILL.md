---
name: latex-pdf
description: |
  Generate LaTeX documents and compile them to PDF. Use whenever the user
  wants a paper, report, thesis, resume, poster, or any math/formula-heavy
  document as a PDF or .tex deliverable, or asks to compile or repair an
  existing .tex file. Works offline with tectonic (self-contained bundle)
  or any local TeX distribution (pdflatex/xelatex).
version: 0.1.0
license: Apache-2.0
category: research
requirements:
  - name: tectonic
    kind: command
    optional: true
    description: Self-contained LaTeX engine (MIT). Preferred compiler; downloads needed packages on first run.
  - name: pdflatex
    kind: command
    optional: true
    description: Fallback LaTeX compiler from a local TeX distribution (TeX Live / MiKTeX).
  - name: xelatex
    kind: command
    optional: true
    description: CJK-capable fallback from the same TeX distribution (TeX Live / MiKTeX). At least one of tectonic, pdflatex or xelatex must be available to compile.
risk: low
third_party:
  - kind: other
    name: Tectonic
    provider: Tectonic Project
    license: MIT
    info_url: https://tectonic-typesetting.github.io/
    terms_url: https://github.com/tectonic-typesetting/tectonic/blob/master/LICENSE
  - kind: other
    name: TeX Live / MiKTeX (pdflatex/xelatex fallback)
    provider: TeX Users Group / MiKTeX Project
    license: free-software (LPPL/GPL per component; see distribution terms)
    info_url: https://tug.org/texlive/
metadata:
  entry_trigger: "paper, report, thesis, resume, poster, .tex, compile latex, math formulas, bibliography"
---

# LaTeX → PDF generation

Generate well-structured LaTeX source and compile it to PDF using a local engine. Everything stays in the workspace: source `.tex`, generated `.pdf`, and any auxiliary files are plain files the user can inspect, re-run, and trace via provenance.

## When to use

- The user wants a **PDF or .tex deliverable**: paper, report, thesis section, resume, poster, math-heavy notes, slides (beamer).
- The user asks to **compile or fix** an existing `.tex` file.
- Content is math-heavy, needs precise typography, references/citations, or publication-style structure.

Do NOT use for: quick plain-text notes (use markdown), spreadsheet-style tabular data (use xlsx skill if present), or binary office formats (docx/pptx are out of scope for this skill).

## Workflow

1. **Check compiler availability first** — do not assume:
   - `command -v tectonic` → preferred compiler.
   - else `command -v pdflatex` (or `xelatex` for CJK documents) → fallback.
   - If neither is found, **stop and report** the missing requirement with install hints: Tectonic prebuilt binaries at `https://github.com/tectonic-typesetting/tectonic/releases` (`brew install tectonic`, `cargo install tectonic`, or download the release tarball), or a TeX Live distribution (`https://tug.org/texlive/`). Do not invent a compilation result.

2. **Write the `.tex` source** as the primary deliverable artifact (the PDF is a derived artifact):
   - Minimal preamble: `\documentclass` (article/report/book/beamer), `\usepackage` set limited to what the document actually needs (geometry, amsmath/amssymb, graphicx, hyperref, and `ctex` or `xeCJK` for Chinese text).
   - For Chinese documents: prefer `xelatex` (or `tectonic` with `\usepackage{ctex}`) — `pdflatex` cannot handle CJK directly.
   - Keep figures as relative paths to workspace files; reference them with `\includegraphics` and `\ref`/`\label` so the PDF remains traceable to its inputs.
   - If the user asked for a specific deliverable (paper/resume/poster), match its structure: title block, sections, bibliography (`thebibliography` or `biblatex`), tables (`tabular`), math (`equation/align`).
   - Place the source in a sensible workspace path, e.g. `report/main.tex`; do not write outside the workspace.

3. **Compile**:
   - `tectonic <file>.tex` (single pass, produces `<file>.pdf` next to the source). First run may download packages — report progress honestly.
   - Fallback: `pdflatex -interaction=nonstopmode -halt-on-error <file>.tex`, run twice when the document has `\label`/`\ref` or a table of contents; `xelatex` likewise for CJK.
   - If compilation fails, quote the **actual error lines** from the log verbatim (do not paraphrase or invent fixes), identify the first error, fix the source, and recompile.

4. **Validate the artifact**:
   - Confirm the PDF exists, is non-empty, and (if `python3` with `pypdf` is available) read its page count and report it.
   - Report to the user: absolute workspace-relative path of the `.tex` source and the `.pdf`, compiler used, and any warnings that affect correctness (missing references, overfull boxes that clip content).

## Guardrails

- Never claim a compilation succeeded without running it. Never fabricate log output or error fixes.
- Keep both source and PDF in the workspace so provenance (sha256 of the PDF, producer tool, inputs) can be captured.
- Do not invent LaTeX packages; if an unknown package fails, prefer a standard alternative or remove the feature and say so.
- Output paths are workspace-relative; the frontend renders the PDF via the workspace file server — never emit `file://` URLs.
