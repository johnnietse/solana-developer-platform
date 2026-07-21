"""Application configuration."""

from dataclasses import dataclass, field
from os import getenv


@dataclass(frozen=True)
class Config:
    # AWS
    s3_bucket: str = getenv("S3_BUCKET", "tmp-sdp-data")
    s3_region: str = getenv("S3_REGION", "us-east-1")
    aws_profile: str | None = getenv("AWS_PROFILE")

    # Solana
    solana_rpc_url: str = getenv(
        "SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"
    )
    solana_rpc_fallback_url: str | None = getenv("SOLANA_RPC_FALLBACK_URL") or None
    solana_rpc_timeout: int = int(getenv("SOLANA_RPC_TIMEOUT", "30"))

    # Server
    host: str = getenv("HOST", "0.0.0.0")
    port: int = int(getenv("PORT", "8080"))
    debug: bool = getenv("DEBUG", "false").lower() == "true"

    # Data
    metrics_prefix: str = getenv("METRICS_PREFIX", "metrics")
    insert_prefix: str = getenv("INSERT_PREFIX", "insert")
    rpc_cache_prefix: str = getenv("RPC_CACHE_PREFIX", "rpc-cache")
    default_metrics_days: int = int(getenv("DEFAULT_METRICS_DAYS", "30"))
    default_transfer_limit: int = int(getenv("DEFAULT_TRANSFER_LIMIT", "100"))

    # Databricks (for S3 → Databricks bridge)
    databricks_host: str | None = getenv("DATABRICKS_HOST") or None
    databricks_token: str | None = getenv("DATABRICKS_TOKEN") or None
    databricks_warehouse_id: str | None = getenv("DATABRICKS_WAREHOUSE_ID") or None

    # Median calculation settings
    median_half_life_days: float = float(getenv("MEDIAN_HALF_LIFE_DAYS", "30.0"))
    median_outlier_threshold: float = float(getenv("MEDIAN_OUTLIER_THRESHOLD", "3.5"))
    median_min_samples: int = int(getenv("MEDIAN_MIN_SAMPLES", "4"))
    median_remove_outliers: bool = getenv("MEDIAN_REMOVE_OUTLIERS", "true").lower() == "true"

    # Ingestion settings
    ingestion_interval_minutes: int = int(getenv("INGESTION_INTERVAL_MINUTES", "15"))
    ingestion_max_retries: int = int(getenv("INGESTION_MAX_RETRIES", "3"))
    ingestion_retry_delay_seconds: int = int(getenv("INGESTION_RETRY_DELAY_SECONDS", "60"))

    # Token discovery
    token_discovery_enabled: bool = getenv("TOKEN_DISCOVERY_ENABLED", "true").lower() == "true"

    # Expanded data ingestion
    holders_ingestion_enabled: bool = getenv("HOLDERS_INGESTION_ENABLED", "true").lower() == "true"
    whales_ingestion_enabled: bool = getenv("WHALES_INGESTION_ENABLED", "true").lower() == "true"
    validators_ingestion_enabled: bool = getenv("VALIDATORS_INGESTION_ENABLED", "true").lower() == "true"

    # RPC settings
    rpc_max_retries: int = int(getenv("RPC_MAX_RETRIES", "3"))
    rpc_retry_delay_seconds: float = float(getenv("RPC_RETRY_DELAY_SECONDS", "1.0"))
    rpc_timeout: int = int(getenv("RPC_TIMEOUT", "30"))

    # Additional RPC URLs for multi-endpoint rotation (comma-separated)
    # When rate-limited on one endpoint, the retry logic rotates to the next.
    solana_rpc_urls: tuple[str, ...] = tuple(
        u.strip() for u in getenv("SOLANA_RPC_URLS", "").split(",") if u.strip()
    )

    # S3 settings
    s3_max_retries: int = int(getenv("S3_MAX_RETRIES", "3"))
    s3_retry_delay_seconds: float = float(getenv("S3_RETRY_DELAY_SECONDS", "1.0"))

    # Extra / override config (parsed from JSON env var CONFIG_EXTRA)
    extra: dict = field(default_factory=lambda: _parse_extra())

    # S3 paths (built from prefix + table name)
    s3_path_templates: dict = field(default_factory=lambda: {
        "metrics": "metrics/{table}/{date}.parquet",
        "insert": "insert/{table}/{date}.parquet",
        "rpc-cache": "rpc-cache/{token_address}.parquet",
    })


def _parse_extra() -> dict:
    """Parse CONFIG_EXTRA env var as JSON, return empty dict on failure."""
    import json
    raw = getenv("CONFIG_EXTRA")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}
