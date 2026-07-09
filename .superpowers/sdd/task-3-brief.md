# Task 3: Update wrangler.toml with analytics cron + env vars

**Files:**
- Modify: `apps/sdp-api/wrangler.toml`

**Changes:**

1. **Update `[triggers]` section** — add analytics cron trigger:
```toml
[triggers]
crons = [
  "* * * * *",         # Transfer reconciliation (existing)
  "*/5 * * * *",       # Analytics ingestion (every 5 min)
]
```

2. **Add to `[vars]` section:**
```toml
ANALYTICS_ENABLED = "true"
ANALYTICS_MINTS = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
```

3. **Add to `[env.dev.vars]` section:**
```toml
ANALYTICS_ENABLED = "true"
ANALYTICS_MINTS = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
```

4. **Add to `[env.production.vars]` section:**
```toml
ANALYTICS_ENABLED = "true"
ANALYTICS_MINTS = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
```

**Verification:**
- No typecheck needed (config file)
- Just verify the file is valid TOML