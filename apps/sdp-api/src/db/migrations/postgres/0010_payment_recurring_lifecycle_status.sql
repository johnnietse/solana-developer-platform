-- Branch-compatibility migration:
-- Re-apply the recurring-payment status constraint with lifecycle claim
-- states for databases that already applied the earlier branch migrations.
ALTER TABLE payment_recurring_payments
    DROP CONSTRAINT IF EXISTS payment_recurring_payments_status_check;

ALTER TABLE payment_recurring_payments
    ADD CONSTRAINT payment_recurring_payments_status_check
    CHECK (status IN ('pending_activation', 'activating', 'active', 'canceling', 'resuming', 'paused', 'canceled', 'expired'));
