import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
} from "@/db/repositories";
import {
  isRecurringPaymentCollectionEnabled,
  isRecurringPaymentsEnabled,
} from "@/lib/feature-flags";
import { collectRecurringPayment as collectRecurringPaymentRecord } from "@/services/payments/recurring-payments";
import type { Env } from "@/types/env";

const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 20;
const DEFAULT_RETRY_AFTER_MINUTES = 30;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export async function collectDueRecurringPayments(env: Env): Promise<{
  scanned: number;
  collected: number;
  failed: number;
}> {
  if (!isRecurringPaymentsEnabled(env) || !isRecurringPaymentCollectionEnabled(env)) {
    return { scanned: 0, collected: 0, failed: 0 };
  }

  const requestedBatchSize = parsePositiveInteger(
    env.PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE,
    DEFAULT_BATCH_SIZE
  );
  const batchSize = Math.min(requestedBatchSize, MAX_BATCH_SIZE);
  if (requestedBatchSize > MAX_BATCH_SIZE) {
    console.warn("Recurring payment collection batch size capped", {
      requestedBatchSize,
      maxBatchSize: MAX_BATCH_SIZE,
      // Collection runs sequential on-chain work on a five-minute cron tick.
      // Keep the batch bounded so slow confirmations do not routinely overlap
      // the next scheduled run.
      cronIntervalMinutes: 5,
    });
  }
  const retryAfterMinutes = parsePositiveInteger(
    env.PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
    DEFAULT_RETRY_AFTER_MINUTES
  );
  const now = new Date();
  const retryAfter = new Date(now.getTime() - retryAfterMinutes * 60 * 1000).toISOString();
  const expiredAttempts = await createPaymentSubscriptionsRepository(
    env
  ).expireStaleUnsignedProcessingAttempts({
    olderThan: retryAfter,
    updatedAt: now.toISOString(),
    limit: batchSize,
  });
  if (expiredAttempts > 0) {
    console.warn("Expired stale unsigned recurring collection attempts", {
      expiredAttempts,
      retryAfter,
    });
  }
  const due = await createPaymentRecurringPaymentsRepository(env).listDueRecurringPayments({
    now: now.toISOString(),
    retryAfter,
    limit: batchSize,
  });
  let collected = 0;
  let failed = 0;

  for (const recurringPayment of due) {
    try {
      await collectRecurringPaymentRecord({
        env,
        organizationId: recurringPayment.organization_id,
        projectId: recurringPayment.project_id,
        recurringPaymentId: recurringPayment.id,
        initiatedByKeyId: null,
        enforceDue: true,
      });
      collected += 1;
    } catch (error) {
      failed += 1;
      console.warn("Recurring payment collection failed", {
        recurringPaymentId: recurringPayment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scanned: due.length, collected, failed };
}
