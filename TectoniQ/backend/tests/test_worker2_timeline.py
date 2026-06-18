"""
Parity + behavior tests for Worker 2 (1D Timeline Mapper).

These lock the observable output contract so the inverted-index refactor can be
proven non-regressive: every assertion here passes on the pre-refactor
implementation and must keep passing afterward.
"""

from workers import worker2_timeline
from workers.worker2_timeline import extract_dates_near_term


def _sample_worker1_output() -> dict:
    """Synthetic Worker 1 output exercising single-word, multi-word, and absent terms."""
    return {
        "sections": [
            {"id": "s0", "header": "CHIEF COMPLAINT", "page": 1,
             "content": "Patient presents with hypertension and chest pain."},
            {"id": "s1", "header": "PAST MEDICAL HISTORY", "page": 2,
             "content": "History of hypertension. Started metformin."},
            {"id": "s2", "header": "ASSESSMENT", "page": 3,
             "content": "Hypertension stable. Plan continue metformin."},
        ],
        # Insertion order matters: ties in first-appearance keep this order.
        "term_frequency": {
            "hypertension": 3,
            "chest": 1,
            "metformin": 2,
            "chest pain": 2,   # multi-word -> substring path
            "asthma": 5,       # never appears -> must be excluded
        },
    }


def _by_term(timeline: list[dict]) -> dict:
    return {e["term"]: e for e in timeline}


def test_absent_terms_excluded():
    result = worker2_timeline.run(_sample_worker1_output())
    terms = {e["term"] for e in result["timeline"]}
    assert "asthma" not in terms


def test_timeline_sorted_by_first_appearance():
    result = worker2_timeline.run(_sample_worker1_output())
    order = [e["term"] for e in result["timeline"]]
    # All of hypertension/chest/chest pain first appear in s0 (idx 0), metformin in s1 (idx 1).
    # Stable sort preserves term_frequency insertion order within the idx-0 tie.
    assert order == ["hypertension", "chest", "chest pain", "metformin"]


def test_single_word_term_occurrences():
    result = worker2_timeline.run(_sample_worker1_output())
    htn = _by_term(result["timeline"])["hypertension"]
    assert htn["count"] == 3
    assert [o["section_id"] for o in htn["occurrences"]] == ["s0", "s1", "s2"]
    assert [o["page"] for o in htn["occurrences"]] == [1, 2, 3]
    assert htn["first_seen"]["section_id"] == "s0"
    assert htn["last_seen"]["section_id"] == "s2"
    assert htn["recurrence_gap"] == 2
    # Order-independent: every section it appears in is recorded.
    assert set(htn["sections_present"]) == {"s0", "s1", "s2"}


def test_recurrence_gap_partial_span():
    result = worker2_timeline.run(_sample_worker1_output())
    metformin = _by_term(result["timeline"])["metformin"]
    assert [o["section_id"] for o in metformin["occurrences"]] == ["s1", "s2"]
    assert metformin["recurrence_gap"] == 1


def test_single_section_term():
    result = worker2_timeline.run(_sample_worker1_output())
    chest = _by_term(result["timeline"])["chest"]
    assert [o["section_id"] for o in chest["occurrences"]] == ["s0"]
    assert chest["first_seen"]["section_id"] == chest["last_seen"]["section_id"] == "s0"
    assert chest["recurrence_gap"] == 0


def test_multi_word_term_matched_as_substring():
    result = worker2_timeline.run(_sample_worker1_output())
    cp = _by_term(result["timeline"])["chest pain"]
    assert [o["section_id"] for o in cp["occurrences"]] == ["s0"]
    assert cp["count"] == 2


def test_alpha_date_preserves_day():
    """A 'Month DD, YYYY' date must keep the day, not collapse to 'Mon YYYY'."""
    content = "Patient admitted to the hospital on March 14, 2024 for chest pain."
    assert extract_dates_near_term("hospital", content) == ["Mar 14, 2024"]


def test_numeric_date_preserves_day():
    """An 'MM/DD/YYYY' date must keep the day."""
    content = "Follow-up hospital visit on 03/22/2024 was uneventful."
    assert extract_dates_near_term("hospital", content) == ["Mar 22, 2024"]


def test_distinct_visits_stay_distinct():
    """Two hospital visits in the same month must not collapse into one date."""
    content = (
        "Admitted to the hospital on March 14, 2024 for chest pain. "
        "Returned to the hospital on March 22, 2024 for follow-up."
    )
    dates = extract_dates_near_term("hospital", content)
    assert dates == ["Mar 14, 2024", "Mar 22, 2024"]


def test_month_year_only_when_no_day():
    """A bare 'Month YYYY' date (no day) still renders as 'Mon YYYY'."""
    content = "Prior hospital admission in Jan 2023 noted."
    assert extract_dates_near_term("hospital", content) == ["Jan 2023"]


def test_word_boundary_no_partial_match():
    """A term must not match inside a larger word (e.g. 'art' inside 'arterial')."""
    w1 = {
        "sections": [
            {"id": "s0", "header": "H", "page": 1, "content": "Arterial line placed."},
        ],
        "term_frequency": {"art": 1},
    }
    result = worker2_timeline.run(w1)
    assert result["timeline"] == []
