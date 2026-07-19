#!/usr/bin/env python3
"""Deterministic statistical integrity gate.

Scans workspace files (or named files) for three risk categories and prints a
fenced ```review JSON block the app renders as reviewer cards.

Usage:
    python stats_integrity_check.py [files...]

If no files are given, scans *.md, *.py, *.R, and *.ipynb in the current
directory (non-recursive).
"""

import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Risk 1: Interpretation — causal/provocative language over an association
# ---------------------------------------------------------------------------
CAUSAL_TRIGGERS = [
    r"\bcauses?\b",
    r"\bdrives?\b",
    r"\bleads?\s+to\b",
    r"\bincreases?\b",
    r"\bdecreases?\b",
    r"\bimproves?\b",
    r"\breduces?\b",
    r"\bprevents?\b",
    r"\btriggers?\b",
    r"\bdetermines?\b",
    # Design terms — NOT triggers when naming the design
    # but they often appear near causal claims
]

DESIGN_TERMS = [
    r"\bRCT\b",
    r"\brandomi[sz]ed\s+controlled?\s+trial\b",
    r"\binstrumental\s+variable\b",
    r"\bIV\s+(?:estimat|regression|approach)\b",
    r"\bdifference[-\s]in[-\s]differences?\b",
    r"\bDiD\b",
    r"\bregression\s+discontinuit",
    r"\bRDD\b",
    r"\bfixed\s+effects?\b",
    r"\bpanel\b.*\bfixed\b",
    r"\bnatural\s+experiment\b",
]

ASSOCIATION_PATTERNS = [
    r"\b(?:is\s+)?associated\s+with\b",
    r"\bcorrelat(?:es?|ed|ion)\b",
    r"\bpredicts?\b",
    r"\brelated\s+to\b",
    r"\blinked\s+to\b",
]

CAUSAL_RE = re.compile("|".join(CAUSAL_TRIGGERS), re.IGNORECASE)
DESIGN_RE = re.compile("|".join(DESIGN_TERMS), re.IGNORECASE)
ASSOC_RE = re.compile("|".join(ASSOCIATION_PATTERNS), re.IGNORECASE)


def check_interpretation(text: str, filepath: str) -> list[dict]:
    """Flag causal language used over associational claims without a named design."""
    findings: list[dict] = []
    sentences = re.split(r"(?<=[.!?])\s+", text)

    for sentence in sentences:
        causal_match = CAUSAL_RE.search(sentence)
        if not causal_match:
            continue

        # Check if a design is named in the same sentence or nearby
        has_design = bool(DESIGN_RE.search(sentence))

        # Check if it's actually associational language nearby
        has_assoc = bool(ASSOC_RE.search(sentence))

        if not has_design:
            level = "error" if has_assoc else "warn"
            findings.append(
                {
                    "level": level,
                    "check": "stats",
                    "tag": "interpretation",
                    "title": f"Causal language without named design: '{causal_match.group(0)}'",
                    "evidence": f"{filepath}: {sentence.strip()[:200]}",
                }
            )

    return findings


# ---------------------------------------------------------------------------
# Risk 2: Preregistration — HARKing detection
# ---------------------------------------------------------------------------
PREREG_FILES = [
    "preregistration.md",
    "analysis_plan.md",
    "analysis_plan.Rmd",
    "prereg.md",
    "preregistration.Rmd",
    "preanalysis.md",
]


def find_prereg_plan(workspace: Path) -> Path | None:
    """Locate a preregistration file in the workspace."""
    for name in PREREG_FILES:
        candidate = workspace / name
        if candidate.is_file():
            return candidate
    # Also check for files starting with "prereg"
    for p in workspace.glob("prereg*"):
        if p.is_file():
            return p
    return None


def extract_prereg_variables(plan_path: Path) -> set[str]:
    """Extract named variables/predictors from a preregistration plan.

    Looks for lines like '- predictor: X' or 'IV: X' or 'variable: X'.
    """
    text = plan_path.read_text(encoding="utf-8", errors="ignore")
    variables: set[str] = set()

    patterns = [
        re.compile(r"(?:predictor|IV|independent\s*variable|variable|covariate)\s*[:=-]\s*(\w[\w\s]*)", re.IGNORECASE),
        re.compile(r"^\s*[-*]\s*(\w[\w\s]+?)(?:\s*\(|$)", re.MULTILINE),
    ]

    for pat in patterns:
        for m in pat.finditer(text):
            var = m.group(1).strip().lower()
            if len(var) > 3 and var not in ("the", "and", "for", "with", "that", "this"):
                variables.add(var)

    return variables


def check_prereg(text: str, filepath: str, prereg_vars: set[str]) -> list[dict]:
    """Flag predictors/interactions not in the preregistration plan."""
    findings: list[dict] = []
    if not prereg_vars:
        return findings

    # Look for regression-like variable usage in code
    # Match patterns like: sm.OLS(y, X[['var1', 'var2']]) or lm(y ~ var1 + var2)
    model_vars_re = re.compile(
        r"(?:X\[\[?|y\s*~|formula\s*=\s*['\"]|independent\s*=|predictors?\s*=\s*)"
        r"([^)\]]+)",
        re.IGNORECASE,
    )

    for m in model_vars_re.finditer(text):
        var_text = m.group(1)
        # Extract individual variable names
        vars_used = set(
            v.strip().strip("'\"")
            for v in re.split(r"[,+]", var_text)
            if v.strip().strip("'\"") and len(v.strip()) > 1
        )

        for var in vars_used:
            var_lower = var.lower().strip("_x0123456789")
            # Skip intercept, constants, and common terms
            if var_lower in ("", "1", "intercept", "const", "c"):
                continue
            # Check if this variable or a close match is in prereg
            # Simple substring check — a real implementation would be more
            # sophisticated
            found = any(
                var_lower in pv or pv in var_lower for pv in prereg_vars
            )
            if not found:
                findings.append(
                    {
                        "level": "warn",
                        "check": "stats",
                        "tag": "prereg",
                        "title": f"Variable '{var}' not found in preregistration plan",
                        "evidence": f"{filepath}: HARKing risk — variable not preregistered",
                    }
                )

    return findings


# ---------------------------------------------------------------------------
# Risk 3: Seed — randomised steps without fixed seed
# ---------------------------------------------------------------------------
SEED_RE = re.compile(
    r"(?:np\.random\.seed|random\.seed|random_state|set\.seed|torch\.manual_seed"
    r"|tf\.random\.set_seed)",
)


RANDOM_STEPS_RE = re.compile(
    r"(?:bootstrap|permutation|train_test_split|KFold|StratifiedKFold|cross_val"
    r"|shuffle|sample|randint|randn?|random\.(?:choice|sample|shuffle)"
    r"|MCMC|Gibbs|\.sample\()",
)


def check_seed(text: str, filepath: str) -> list[dict]:
    """Flag randomised steps that lack a fixed seed."""
    findings: list[dict] = []

    random_steps = RANDOM_STEPS_RE.findall(text)
    if not random_steps:
        return findings

    has_seed = bool(SEED_RE.search(text))

    if not has_seed:
        findings.append(
            {
                "level": "warn",
                "check": "stats",
                "tag": "seed",
                "title": f"Randomised step without fixed seed: {', '.join(set(random_steps[:5]))}",
                "evidence": f"{filepath}: add np.random.seed(42) or equivalent before randomised steps",
            }
        )

    return findings


# ---------------------------------------------------------------------------
# File scanning
# ---------------------------------------------------------------------------
SCAN_EXTENSIONS = {".py", ".R", ".md", ".Rmd", ".qmd", ".ipynb"}


def scan_files(paths: list[str]) -> list[dict]:
    """Scan files for integrity risks and return findings."""
    all_findings: list[dict] = []

    if paths:
        files = [Path(p) for p in paths if Path(p).is_file()]
    else:
        workspace = Path.cwd()
        files = [p for p in workspace.iterdir() if p.suffix in SCAN_EXTENSIONS]

    # Find preregistration plan (scan workspace)
    workspace = Path.cwd()
    prereg_path = find_prereg_plan(workspace)
    prereg_vars: set[str] = set()
    if prereg_path:
        prereg_vars = extract_prereg_variables(prereg_path)

    for filepath in files:
        try:
            text = filepath.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        all_findings.extend(check_interpretation(text, str(filepath)))
        if prereg_vars:
            all_findings.extend(check_prereg(text, str(filepath), prereg_vars))
        all_findings.extend(check_seed(text, str(filepath)))

    # Deduplicate by title + evidence
    seen = set()
    unique: list[dict] = []
    for f in all_findings:
        key = (f["title"], f["evidence"][:80])
        if key not in seen:
            seen.add(key)
            unique.append(f)

    return unique


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    paths = sys.argv[1:] if len(sys.argv) > 1 else []
    findings = scan_files(paths)

    result = {
        "findings": findings,
        "note": (
            "Stats integrity gate — checked interpretation language, "
            "preregistration consistency, and seed fixation. "
            "Absence of findings is not a guarantee of correctness."
        ),
    }

    print("```review")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("```")


if __name__ == "__main__":
    main()
