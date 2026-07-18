"""Offline skill trigger fixture evaluator tests."""

from services.skill_eval import evaluate_skill


def test_skill_eval_reports_precision_and_recall():
    result = evaluate_skill(
        "literature-review",
        "Find and compare scientific papers.",
        [
            {"prompt": "Search papers about cancer", "expected_trigger": True, "trigger_terms": ["papers"]},
            {"prompt": "Delete a file", "expected_trigger": False, "trigger_terms": ["papers"]},
        ],
    )
    assert result["precision"] == 1.0
    assert result["recall"] == 1.0
    assert result["failed"] == 0

