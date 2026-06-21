"""
Unit tests for the TectoniQ Flask App endpoints.
"""

import pytest
from app import app


@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


def test_suggest_keywords_empty(client):
    rv = client.get("/api/keywords/suggest")
    assert rv.status_code == 200
    assert rv.json == []

    rv2 = client.get("/api/keywords/suggest?q=   ")
    assert rv2.status_code == 200
    assert rv2.json == []


def test_suggest_keywords_valid(client):
    rv = client.get("/api/keywords/suggest?q=hepat")
    assert rv.status_code == 200
    assert isinstance(rv.json, list)
    assert len(rv.json) <= 20
    # "hepatitis" should be present in the suggestions list
    assert "hepatitis" in rv.json


def test_suggest_keywords_prefix_priority(client):
    rv = client.get("/api/keywords/suggest?q=hep")
    assert rv.status_code == 200
    # First few items should start with 'hep'
    for term in rv.json[:3]:
        assert term.startswith("hep")
