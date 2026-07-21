# Databricks Production Workspace (Waddah's)

> Discovered 2026-07-20. Not yet configured — needs access token.

## Warehouse Info
| Field | Value |
|-------|-------|
| Name | Classic Warehouse (Serverless) |
| Host | `dbc-8f4a920c-45cb.cloud.databricks.com` |
| Workspace ID | `1125560347127367` |
| HTTP Path | `/sql/1.0/warehouses/bebc0b84d34202ba` |
| Warehouse ID | `bebc0b84d34202ba` |
| JDBC URL | `jdbc:databricks://dbc-8f4a920c-45cb.cloud.databricks.com:443/default;transportMode=http;ssl=1;AuthMech=3;httpPath=/sql/1.0/warehouses/bebc0b84d34202ba;` |
| OAuth URL | `https://dbc-8f4a920c-45cb.cloud.databricks.com/oidc` |
| Size | 2X-Small, Serverless |
| Auto-stop | After 5 min inactivity |

## Status
- [ ] Need access token to connect
- [ ] Test Delta S3 query once token obtained
- [ ] Update config.py and Polars API env vars

## Credentials Needed
```
DATABRICKS_HOST=dbc-8f4a920c-45cb.cloud.databricks.com
DATABRICKS_WAREHOUSE_ID=bebc0b84d34202ba
DATABRICKS_TOKEN=<get from Waddah or generate in workspace>
```
