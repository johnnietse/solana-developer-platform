ALTER TABLE payment_recurring_payments
    DROP CONSTRAINT IF EXISTS payment_recurring_payments_status_check_v2;

ALTER TABLE payment_recurring_payments
    ADD CONSTRAINT payment_recurring_payments_status_check_v2
    CHECK (status IN ('pending_activation', 'activating', 'active', 'canceling', 'resuming', 'paused', 'canceled', 'expired'))
    NOT VALID;

ALTER TABLE payment_recurring_payments
    VALIDATE CONSTRAINT payment_recurring_payments_status_check_v2;

ALTER TABLE payment_recurring_payments
    DROP CONSTRAINT IF EXISTS payment_recurring_payments_status_check;

ALTER TABLE payment_recurring_payments
    RENAME CONSTRAINT payment_recurring_payments_status_check_v2
    TO payment_recurring_payments_status_check;
