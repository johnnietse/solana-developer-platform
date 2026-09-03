import os

import polars as pl


def env(name, default=None):
    # A blank `KEY=` line in a sourced .env sets the var to "" rather than
    # leaving it unset, so treat blank the same as unset instead of letting
    # it silently override a working default.
    value = os.environ.get(name)
    return value if value else default


if not os.environ.get("AWS_PROFILE"):
    os.environ.pop("AWS_PROFILE", None)


S3_METRICS_TABLE_PATH = env("S3_METRICS_TABLE_PATH", "s3://tmp-sdp-data/dev/mlh/polars_metrics")
S3_METRICS_VALUES_TABLE_PATH = env(
    "S3_METRICS_VALUES_TABLE_PATH", "s3://tmp-sdp-data/dev/mlh/polars_metrics_values"
)
RPC_URL = env("SOLANA_RPC_URL", "https://api.devnet.solana.com")
INSERT_BUCKET = env("S3_INSERT_BUCKET", "tmp-sdp-data")

# Delta table backing the GET /rpc cache. Same bucket as /insert writes to, and
# reachable from Databricks at dev.mlh.rpc.
RPC_TABLE_NAME = env("S3_RPC_TABLE_NAME", "dev.mlh.rpc")
RPC_TABLE_PATH = f"s3://{INSERT_BUCKET}/{RPC_TABLE_NAME.replace('.', '/')}"

STORAGE_OPTIONS = {
    key: value
    for key, value in {
        "aws_region": env("AWS_REGION", "us-east-1"),
        "aws_access_key_id": env("AWS_ACCESS_KEY_ID"),
        "aws_secret_access_key": env("AWS_SECRET_ACCESS_KEY"),
        # Required whenever the credentials are temporary — an assumed role, an
        # SSO session, or an ECS task role. Without it those keys are rejected
        # as invalid rather than as expired, which reads like a wrong-secret
        # problem instead of a missing-token one.
        "aws_session_token": env("AWS_SESSION_TOKEN"),
    }.items()
    if value
}

# Credential resolution, in the order the runtime environments actually occur.
#
#   static keys in env  -> STORAGE_OPTIONS above already carries them
#   named local profile -> CredentialProviderAWS(profile_name=...)
#   ECS / EC2 / role    -> CredentialProviderAWS() with no arguments, which
#                          walks the standard chain and picks up the container
#                          credentials endpoint that ECS injects
#
# The last case is the one that matters in production and the one a
# profile-only setup silently fails: on ECS there is no profile and no static
# key, so leaving the provider as None hands Delta no credentials at all.
DELTA_CREDENTIAL_PROVIDER = None
if not STORAGE_OPTIONS.get("aws_access_key_id"):
    if env("AWS_PROFILE"):
        DELTA_CREDENTIAL_PROVIDER = pl.CredentialProviderAWS(
            profile_name=os.environ["AWS_PROFILE"]
        )
    else:
        try:
            DELTA_CREDENTIAL_PROVIDER = pl.CredentialProviderAWS()
        except Exception:
            # No resolvable credentials. Leave it None so the S3 call fails with
            # its own error rather than this raising at import and taking the
            # whole app down before it can serve /healthz.
            DELTA_CREDENTIAL_PROVIDER = None

# ── Security ──
#
# API_WRITE_TOKEN gates POST /insert. Unset means the endpoint is disabled
# rather than open: this service is reachable from the internet once its
# security group allows 8080, and /insert appends to any Delta table under
# S3_INSERT_BUCKET. Without a gate, anyone who finds the address can append
# rows to dev/mlh/polars_metrics_values — the table the dashboard reads — and
# there is nothing in the request to say the rows are not ours.
#
# Failing closed is deliberate. A missing token in production is a
# misconfiguration; serving writes anyway would turn it into a breach.
API_WRITE_TOKEN = env("API_WRITE_TOKEN")

# Prefix every /insert write must fall under. table_name maps dots to slashes,
# so an unconstrained value can address any key in the bucket, including the
# metric tables Databricks owns. S3 keys are flat — ".." cannot escape a
# bucket — so this is about blast radius inside it, not path traversal.
INSERT_TABLE_PREFIX = env("INSERT_TABLE_PREFIX", "dev.mlh.")

# Allow ?rpc= to override the Solana endpoint. The parameter makes the server
# issue a request to a caller-supplied URL — an SSRF primitive, and the host
# runs with IMDSv1 enabled (HttpTokens: optional), so the metadata service on
# 169.254.169.254 answers unauthenticated requests. Off by default; the
# cluster= parameter already covers choosing devnet/testnet/mainnet.
ALLOW_RPC_URL_OVERRIDE = env("ALLOW_RPC_URL_OVERRIDE", "false").lower() == "true"

DEFAULT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
DEFAULT_CLUSTER = "devnet"
DEFAULT_DAYS = 30
DEFAULT_TRANSFER_LIMIT = 100
PAGE_SIZE = 1000

CLUSTER_RPC = {
    "devnet": "https://api.devnet.solana.com",
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
    "testnet": "https://api.testnet.solana.com",
}
