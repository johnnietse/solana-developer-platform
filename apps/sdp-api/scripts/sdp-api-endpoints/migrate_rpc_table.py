"""One-time migration of dev/mlh/rpc to the per-transfer schema.

Background
----------
The table was created with the shape of the old /rpc response, which returned
a transaction count:

    mint · cluster · days · transactionCount · since

/rpc now returns the last 100 transfers, so a row is one transaction:

    mint · cluster · signature · slot · block_time · failed · fetched_at

Delta append requires the incoming schema to match the stored one, so the new
rows are rejected with "Cannot cast schema, number of fields does not match:
7 vs 5". Approved by Waddah on 2026-08-26: "Overwrite the table" and "use the
new 7-column individual transaction schema".

Why this is a script and not a flag on /insert
----------------------------------------------
/insert is append-only by design — a write endpoint that can replace a table
on a query parameter is a footgun. This is a schema migration, which is a
different operation that happens once, so it lives outside the endpoint.

The old row is not destroyed. Overwrite creates a new Delta version; the
previous one stays readable and restorable until someone runs VACUUM:

    DeltaTable(path).restore(0)

Usage
-----
    AWS_PROFILE=sdp-user python migrate_rpc_table.py          # show the plan
    AWS_PROFILE=sdp-user python migrate_rpc_table.py --apply  # do it
"""

import sys

import polars as pl

from config import DELTA_CREDENTIAL_PROVIDER, RPC_TABLE_PATH, STORAGE_OPTIONS

# The schema /rpc now produces. Written with one row of correct types and then
# cleared, so the table is established empty rather than seeded with a fake
# transaction that a reader could mistake for real chain data.
TARGET_SCHEMA = {
    "mint": pl.String,
    "cluster": pl.String,
    "signature": pl.String,
    "slot": pl.Int64,
    "block_time": pl.Int64,
    "failed": pl.Boolean,
    "fetched_at": pl.String,
}


def read_current():
    try:
        return pl.read_delta(
            RPC_TABLE_PATH,
            storage_options=STORAGE_OPTIONS,
            credential_provider=DELTA_CREDENTIAL_PROVIDER,
        )
    except Exception as exc:
        print(f"  could not read the existing table: {type(exc).__name__}: {exc}")
        return None


def main():
    apply = "--apply" in sys.argv
    print(f"target: {RPC_TABLE_PATH}\n")

    current = read_current()
    if current is not None:
        print(f"current: {len(current)} row(s), schema {list(current.schema)}")
        for row in current.head(5).to_dicts():
            print(f"    {row}")
    print()

    print(f"new schema: {list(TARGET_SCHEMA)}")
    print()

    if not apply:
        print("Dry run. Re-run with --apply to overwrite.")
        print("The current version stays restorable via DeltaTable.restore(0).")
        return

    empty = pl.DataFrame(schema=TARGET_SCHEMA)
    empty.write_delta(
        RPC_TABLE_PATH,
        mode="overwrite",
        storage_options=STORAGE_OPTIONS,
        credential_provider=DELTA_CREDENTIAL_PROVIDER,
        delta_write_options={"schema_mode": "overwrite"},
    )

    after = read_current()
    print(f"done: {len(after)} row(s), schema {list(after.schema)}")
    print("The previous version is still readable as version 0.")


if __name__ == "__main__":
    main()
