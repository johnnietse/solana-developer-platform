import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
} from "@/db/repositories";
import { parsePositiveIntegerConfig } from "@/lib/config";
import {
  isRecurringPaymentCollectionEnabled,
  isRecurringPaymentsEnabled,
} from "@/lib/feature-flags";
import { collectRecurringPayment as collectRecurringPaymentRecord } from "@/services/payments/recurring-payments";
import type { Env } from "@/types/env";

const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 20;
const DEFAULT_RETRY_AFTER_MINUTES = 30;

export async function collectDueRecurringPayments(env: Env): Promise<{
  scanned: number;
  collected: number;
  failed: number;
  expirationFailures: number;
  collectionFailures: number;
}> {
  if (!isRecurringPaymentsEnabled(env) || !isRecurringPaymentCollectionEnabled(env)) {
    return { scanned: 0, collected: 0, failed: 0, expirationFailures: 0, collectionFailures: 0 };
  }

  const requestedBatchSize = parsePositiveIntegerConfig(
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
  const retryAfterMinutes = parsePositiveIntegerConfig(
    env.PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES,
    DEFAULT_RETRY_AFTER_MINUTES
  );
  const now = new Date();
  const retryAfter = new Date(now.getTime() - retryAfterMinutes * 60 * 1000).toISOString();
  let expirationFailures = 0;
  try {
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
  } catch (error) {
    expirationFailures += 1;
    console.warn("Failed to expire stale unsigned recurring collection attempts", {
      retryAfter,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const due = await createPaymentRecurringPaymentsRepository(env).listDueRecurringPayments({
    now: now.toISOString(),
    retryAfter,
    limit: batchSize,
  });
  let collected = 0;
  let collectionFailures = 0;

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
      collectionFailures += 1;
      console.warn("Recurring payment collection failed", {
        recurringPaymentId: recurringPayment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scanned: due.length,
    collected,
    failed: expirationFailures + collectionFailures,
    expirationFailures,
    collectionFailures,
  };
}
