#!/usr/bin/env python3
"""Extract text, citation identifiers, and quantitative claims from a PDF.

Usage:
    python pdf_extract.py document.pdf

Output (JSON to stdout):
    {
      "backend": "pypdf" | "none",
      "pages": <int>,
      "chars": <int>,
      "citations": {"dois": [...], "arxiv": [...], "pmids": [...]},
      "claims": [{"kind": "statistic"|"percentage"|"pvalue"|"sample_size", "text": "...", "context": "..."}],
      "text": "<full extracted text>"
    }

If no PDF backend is available, prints {"error": "<message>"}.
"""

import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# PDF backends — try pypdf first, fall back to no backend
# ---------------------------------------------------------------------------
PDF_BACKEND = None


def _try_pypdf():
    try:
        from pypdf import PdfReader  # noqa: F811
        return "pypdf"
    except ImportError:
        return None


def extract_text_pypdf(path: str) -> tuple[str, int]:
    from pypdf import PdfReader

    reader = PdfReader(path)
    pages = len(reader.pages)
    parts: list[str] = []
    for page in reader.pages:
        text = page.extract_text()
        if text:
            parts.append(text)
    return "\n".join(parts), pages


# ---------------------------------------------------------------------------
# Identifier extraction
# ---------------------------------------------------------------------------
DOI_RE = re.compile(r"\b10\.\d{4,}/[^\s\]\)}\"']+")
ARXIV_RE = re.compile(
    r"\b(?:arxiv\s*:\s*|arXiv:)(\d{4}\.\d{4,}(?:v\d+)?)",
    re.IGNORECASE,
)
PMID_RE = re.compile(r"\bPMID\s*:\s*(\d{5,8})\b", re.IGNORECASE)


def extract_citations(text: str) -> dict:
    dois = list(set(DOI_RE.findall(text)))
    # Clean trailing punctuation from DOIs
    dois = [re.sub(r"[,;.!?]+$", "", d) for d in dois]

    arxiv_ids = list(set(ARXIV_RE.findall(text)))
    pmids = list(set(PMID_RE.findall(text)))

    return {"dois": dois, "arxiv": arxiv_ids, "pmids": pmids}


# ---------------------------------------------------------------------------
# Quantitative claim detection
# ---------------------------------------------------------------------------
CLAIM_PATTERNS = [
    (
        "statistic",
        re.compile(
            r"(?:t[-\s]?(?:test|value|statistic)|F[-\s]?(?:test|value|statistic|ratio)"
            r"|χ\s*(?:²|2|squared)|chi[-\s]?squared?|r\s*(?:²|2|squared)?"
            r"|R\s*(?:²|2|squared)?|AUC|ROC|MSE|RMSE|MAE|accuracy|precision|recall"
            r"|F1|sensitivity|specificity|odds.ratio|hazard.ratio|OR\s*=|HR\s*=)",
            re.IGNORECASE,
        ),
    ),
    (
        "percentage",
        re.compile(
            r"\d+(?:\.\d+)?\s*%(?:\s*(?:CI|confidence))?|\d+(?:\.\d+)?\s*percent",
            re.IGNORECASE,
        ),
    ),
    (
        "pvalue",
        re.compile(
            r"p\s*(?:[<>=]=?|value)\s*\d+\.?\d*(?:e[+-]?\d+)?"
            r"|p\s*<\s*0?\.0+1",
            re.IGNORECASE,
        ),
    ),
    (
        "sample_size",
        re.compile(
            r"(?:n|N|sample\s*size)\s*[=:]\s*\d[\d,]*(?:\s*\(\s*\d[\d,]*\s*\))?",
        ),
    ),
]


def extract_claims(text: str) -> list[dict]:
    claims: list[dict] = []
    sentences = re.split(r"(?<=[.!?])\s+", text)

    for sentence in sentences:
        for kind, pattern in CLAIM_PATTERNS:
            match = pattern.search(sentence)
            if match:
                # Get surrounding context (±120 chars)
                start = max(0, match.start() - 60)
                end = min(len(sentence), match.end() + 60)
                context = sentence[start:end].strip()
                claims.append(
                    {
                        "kind": kind,
                        "text": match.group(0),
                        "context": context,
                    }
                )
                break  # one classification per sentence

    return claims


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: pdf_extract.py <file.pdf>"}))
        sys.exit(1)

    path = sys.argv[1]
    if not Path(path).is_file():
        print(json.dumps({"error": f"File not found: {path}"}))
        sys.exit(1)

    backend = _try_pypdf()
    if backend is None:
        print(
            json.dumps(
                {
                    "error": "No PDF backend available. Install pypdf: pip install pypdf",
                }
            )
        )
        sys.exit(1)

    try:
        text, pages = extract_text_pypdf(path)
    except Exception as exc:
        print(json.dumps({"error": f"Failed to extract PDF text: {exc}"}))
        sys.exit(1)

    citations = extract_citations(text)
    claims = extract_claims(text)

    result = {
        "backend": backend,
        "pages": pages,
        "chars": len(text),
        "citations": citations,
        "claims": claims,
        "text": text,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
