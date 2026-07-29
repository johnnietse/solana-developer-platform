import polars as pl
import pytest
from botocore.exceptions import ProfileNotFound

from app import (
    MetricsUnavailableError,
    _credential_provider,
    _profile_credential_provider,
    _storage_options,
    app as flask_app,
)

AWS_ENV_VARS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_ENDPOINT_URL",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
)


@pytest.fixture
def client():
    flask_app.config.update(TESTING=True)
    return flask_app.test_client()


@pytest.fixture
def clean_aws_env(monkeypatch):
    """Drop any AWS credentials inherited from the developer's shell."""
    for name in AWS_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    _profile_credential_provider.cache_clear()
    yield
    _profile_credential_provider.cache_clear()


def test_healthz(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok"}


def test_metrics_returns_latest_overview(client, monkeypatch):
    fake_overview = {
        "stablecoins": [{"symbol": "USDC", "totalSupply": 123.0}],
        "holders": {"totalHolders": 42},
        "holdersHistory": [],
        "supplyHistory": [],
        "holderCount": 42,
        "totalSupply": 123.0,
        "lastUpdated": "2026-07-24T00:00:00+00:00",
    }

    def fake_fetch(table_path, region):
        return fake_overview

    monkeypatch.setattr("app.fetch_latest_overview", fake_fetch)

    resp = client.get("/metrics")

    assert resp.status_code == 200
    assert resp.get_json() == {"data": fake_overview}


def test_metrics_returns_503_when_table_unavailable(client, monkeypatch):
    def fake_fetch(table_path, region):
        raise MetricsUnavailableError("no rows in table")

    monkeypatch.setattr("app.fetch_latest_overview", fake_fetch)

    resp = client.get("/metrics")

    assert resp.status_code == 503
    body = resp.get_json()
    assert body["error"] == "metrics_unavailable"
    assert "no rows in table" in body["message"]


def test_storage_options_never_carries_profile(clean_aws_env, monkeypatch):
    """object_store ignores an `aws_profile` key and falls back to IMDS, so a
    profile in storage_options would look like a metadata-endpoint timeout."""
    monkeypatch.setenv("AWS_PROFILE", "solana-dev")

    assert _storage_options("us-east-1") == {"aws_region": "us-east-1"}


def test_credential_provider_uses_profile(clean_aws_env, monkeypatch, tmp_path):
    credentials = tmp_path / "credentials"
    credentials.write_text(
        "[solana-dev]\n"
        "aws_access_key_id = AKIAEXAMPLE\n"
        "aws_secret_access_key = secret\n"
    )
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setenv("AWS_PROFILE", "solana-dev")

    provider = _credential_provider("us-east-1")

    assert isinstance(provider, pl.CredentialProviderAWS)
    assert provider()[0]["aws_access_key_id"] == "AKIAEXAMPLE"


def test_credential_provider_rejects_unknown_profile(clean_aws_env, monkeypatch, tmp_path):
    """A bad profile must surface as ProfileNotFound here — discovered later,
    inside scan_delta, it degrades into an unreadable FFI error."""
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "credentials"))
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "config"))
    monkeypatch.setenv("AWS_PROFILE", "does-not-exist")

    with pytest.raises(ProfileNotFound):
        _credential_provider("us-east-1")


def test_credential_provider_defers_to_static_keys(clean_aws_env, monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("AWS_PROFILE", "solana-dev")

    assert _credential_provider("us-east-1") is None


def test_credential_provider_defaults_to_auto(clean_aws_env):
    """No profile, no static keys: ECS task role / instance profile."""
    assert _credential_provider("us-east-1") == "auto"
