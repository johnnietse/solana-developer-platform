"""Contract tests for GET /rpc.

The response body IS the dev.mlh.rpc_counts Delta schema — insert_rpc.py appends
it verbatim — so a drift in these keys silently corrupts the table. Everything
that would touch S3 or the network is patched out.
"""

import pytest

import app as app_module
from app import RPC_SCHEMA, app as flask_app


@pytest.fixture
def client():
    flask_app.config.update(TESTING=True)
    return flask_app.test_client()


@pytest.fixture
def offline(monkeypatch):
    """No RPC, no cache read, no Delta write."""
    monkeypatch.setattr(app_module, "read_cached", lambda *a, **k: None)
    monkeypatch.setattr(app_module, "insert_delta", lambda *a, **k: ("s3://test/table", 1))
    monkeypatch.setattr(
        app_module, "count_recent_transactions", lambda options: (42, 1, 1_756_000_000)
    )


def test_rpc_body_is_exactly_the_table_schema(client, offline):
    body = client.get("/rpc?days=1").get_json()
    assert set(body) == set(RPC_SCHEMA)


def test_rpc_reports_the_count_and_echoes_the_query(client, offline):
    body = client.get("/rpc?days=7&cluster=testnet&mint=SoMeMint111").get_json()
    assert body["transactionCount"] == 42
    assert body["days"] == 7
    assert body["cluster"] == "testnet"
    assert body["mint"] == "SoMeMint111"


def test_cache_hit_short_circuits_the_rpc_call(client, monkeypatch):
    cached = {
        "mint": "M",
        "cluster": "devnet",
        "days": 1,
        "transactionCount": 7,
        "since": "2026-09-01T00:00:00.000Z",
    }
    monkeypatch.setattr(app_module, "read_cached", lambda *a, **k: cached)

    def explode(options):
        raise AssertionError("a cache hit must not reach the RPC")

    monkeypatch.setattr(app_module, "count_recent_transactions", explode)

    response = client.get("/rpc?days=1&mint=M")
    assert response.status_code == 200
    assert response.headers["X-Cache"] == "HIT"
    assert response.get_json() == cached


def test_refresh_bypasses_the_cache(client, offline, monkeypatch):
    monkeypatch.setattr(app_module, "read_cached", lambda *a, **k: {"never": "used"})
    response = client.get("/rpc?days=1&refresh=true")
    assert response.headers["X-Cache"] == "MISS"
    assert response.get_json()["transactionCount"] == 42


def test_include_failed_is_never_cached(client, offline, monkeypatch):
    """It changes the count but is not a column, so it must not be written."""
    writes = []
    monkeypatch.setattr(
        app_module, "insert_delta", lambda *a, **k: writes.append(a) or ("s3://t", 1)
    )
    client.get("/rpc?days=1&include_failed=true")
    assert writes == []


def test_a_failed_cache_write_still_answers(client, offline, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("no credentials")

    monkeypatch.setattr(app_module, "insert_delta", boom)
    response = client.get("/rpc?days=1")
    assert response.status_code == 200
    assert response.get_json()["transactionCount"] == 42


def test_upstream_rpc_failure_is_502_not_400(client, monkeypatch):
    monkeypatch.setattr(app_module, "read_cached", lambda *a, **k: None)

    def boom(options):
        raise RuntimeError("RPC HTTP 429")

    monkeypatch.setattr(app_module, "count_recent_transactions", boom)
    response = client.get("/rpc?days=1")
    assert response.status_code == 502


@pytest.mark.parametrize(
    "query",
    ["cluster=bogus", "days=abc", "days=0", "days=366", "days=-5", "mint=%20"],
)
def test_bad_input_is_rejected_before_any_rpc(client, monkeypatch, query):
    def explode(options):
        raise AssertionError("invalid input must not reach the RPC")

    monkeypatch.setattr(app_module, "count_recent_transactions", explode)
    assert client.get(f"/rpc?{query}").status_code == 400
