"""
Unit tests for Worker 7 (Clinical Term Filter).
"""

from workers import worker7_filter


def test_worker7_whitelists_medical_terms():
    """Ensure that medical terms in the dictionary are kept."""
    w6_output = {
        "sections": [],
        "term_frequency": {
            "hypertension": 5,
            "metformin": 3,
            "tamoxifen": 2,
        },
        "page_count": 1,
        "section_outline": [],
    }
    result = worker7_filter.run(w6_output)
    tf = result["term_frequency"]
    assert "hypertension" in tf
    assert "metformin" in tf
    assert "tamoxifen" in tf
    assert tf["hypertension"] == 5


def test_worker7_blacklists_non_medical_terms():
    """Ensure that words on the blacklist are removed."""
    w6_output = {
        "sections": [],
        "term_frequency": {
            "doctor": 10,
            "hospital": 8,
            "patient": 12,
            "cornell": 4,
            "metformin": 3,
        },
        "page_count": 1,
        "section_outline": [],
    }
    result = worker7_filter.run(w6_output)
    tf = result["term_frequency"]
    assert "doctor" not in tf
    assert "hospital" not in tf
    assert "patient" not in tf
    assert "cornell" not in tf
    assert "metformin" in tf


def test_worker7_removes_short_and_digits():
    """Ensure that <3 length terms and numeric terms are removed."""
    w6_output = {
        "sections": [],
        "term_frequency": {
            "ox": 5,     # too short
            "123": 8,    # purely numeric
            "metformin": 3,
        },
        "page_count": 1,
        "section_outline": [],
    }
    result = worker7_filter.run(w6_output)
    tf = result["term_frequency"]
    assert "ox" not in tf
    assert "123" not in tf
    assert "metformin" in tf
