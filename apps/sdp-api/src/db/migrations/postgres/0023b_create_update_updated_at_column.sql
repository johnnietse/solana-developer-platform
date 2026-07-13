-- Defines the update_updated_at_column() trigger function.
--
-- Migration 0024_analytics_tokens.sql creates a BEFORE UPDATE trigger that
-- calls this function, but the function was never defined inside the
-- migration set. It only existed in an orphan, malformed
-- create_trigger_function.sql that nothing executed, so `migrate-postgres.mjs`
-- failed at 0024 with "function update_updated_at_column() does not exist".
--
-- This migration adds the definition so the trigger in 0024 (and any future
-- table) can be created. It is idempotent (CREATE OR REPLACE FUNCTION) and is
-- named 0023b so it is applied before 0024 on a fresh database.
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = sdp_datetime_now();
  RETURN NEW;
END;
$$;
