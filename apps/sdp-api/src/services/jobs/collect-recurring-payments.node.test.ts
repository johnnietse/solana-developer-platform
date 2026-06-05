import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
} from "@/db/repositories";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import { collectRecurringPayment } from "@/services/payments/recurring-payments";
import type { Env } from "@/types/env";
import { collectDueRecurringPayments } from "./collect-recurring-payments";

vi.mock("@/db/repositories", () => ({
  createPaymentRecurringPaymentsRepository: vi.fn(),
  createPaymentSubscriptionsRepository: vi.fn(),
}));

vi.mock("@/services/payments/recurring-payments", () => ({
  collectRecurringPayment: vi.fn(),
}));

const enabledEnv = {
  PAYMENTS_RECURRING_ENABLED: "true",
  PAYMENTS_RECURRING_COLLECTION_ENABLED: "true",
} as Env;

function makeRecurringPayment(
  overrides: Partial<PaymentRecurringPaymentRow> = {}
): PaymentRecurringPaymentRow {
  const now = new Date().toISOString();

  return {
    id: "prp_test",
    organization_id: "org_test",
    project_id: "prj_test",
    source_wallet_id: "wal_test",
    source_address: "source_address_test",
    counterparty_id: "cp_test",
    counterparty_account_id: "cpa_test",
    destination_address: "destination_address_test",
    destination_token_account: null,
    token: "token_test",
    amount: "1.00",
    period_hours: 24,
    first_collection_at: null,
    next_collection_due_at: now,
    plan_id: "psp_test",
    subscription_id: "psub_test",
    plan_pda: "plan_pda_test",
    plan_created_at: "1",
    plan_creation_signature: "sig_plan_test",
    subscription_pda: "subscription_pda_test",
    subscription_authority_address: "subscription_authority_test",
    authorization_signature: "sig_authorization_test",
    status: "active",
    metadata_uri: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("collectDueRecurringPayments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continues collecting due payments when stale attempt expiration fails", async () => {
    const duePayment = makeRecurringPayment();
    const expireStaleUnsignedProcessingAttempts = vi
      .fn()
      .mockRejectedValue(new Error("temporary database outage"));
    const listDueRecurringPayments = vi.fn().mockResolvedValue([duePayment]);
    vi.mocked(createPaymentSubscriptionsRepository).mockReturnValue({
      expireStaleUnsignedProcessingAttempts,
    } as unknown as ReturnType<typeof createPaymentSubscriptionsRepository>);
    vi.mocked(createPaymentRecurringPaymentsRepository).mockReturnValue({
      listDueRecurringPayments,
    } as unknown as ReturnType<typeof createPaymentRecurringPaymentsRepository>);
    vi.mocked(collectRecurringPayment).mockResolvedValue(
      {} as Awaited<ReturnType<typeof collectRecurringPayment>>
    );

    const result = await collectDueRecurringPayments(enabledEnv);

    expect(result).toEqual({
      scanned: 1,
      collected: 1,
      failed: 1,
      expirationFailures: 1,
      collectionFailures: 0,
    });
    expect(listDueRecurringPayments).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
      })
    );
    expect(collectRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: enabledEnv,
        organizationId: duePayment.organization_id,
        projectId: duePayment.project_id,
        recurringPaymentId: duePayment.id,
        initiatedByKeyId: null,
        enforceDue: true,
      })
    );
  });
});
