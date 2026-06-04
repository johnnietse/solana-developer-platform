import { getDb } from "@/db";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPostgresPaymentRecurringPaymentsRepository,
  createPostgresPaymentSubscriptionsRepository,
  createPostgresPaymentsRepository,
} from "@/db/repositories";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import type {
  PaymentSubscriptionCollectionAttemptRow,
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories/payment-subscriptions.repository";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { AppError } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import { createSigningService } from "@/services/domain/signing.service";
import { assertWalletPolicyAllowsTransferWithRepository } from "@/services/payments/wallet-policy";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { resolveSolanaCounterpartyAccount } from "./counterparty-account-resolution";
import {
  assertSubscriptionTokenMint,
  collectSubscriptionOnChain,
  deriveAssociatedTokenAccount,
  ensureSubscriptionAuthorizationOnChain,
  ensureSubscriptionPlanOnChain,
  executeSubscriptionLifecycleOnChain,
  generateProgramPlanId,
  resolveRecurringSubscriptionRuntime,
} from "./solana-subscriptions-adapter";

export type ActivationResult = {
  recurringPayment: PaymentRecurringPaymentRow;
  planSignature?: string;
  authorizationSignature?: string;
};

export type CollectionResult = {
  recurringPayment: PaymentRecurringPaymentRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
};

function addPeriodHours(timestamp: string, periodHours: number): string {
  return new Date(new Date(timestamp).getTime() + periodHours * 60 * 60 * 1000).toISOString();
}

const ACTIVATION_CLAIM_TTL_MS = 10 * 60 * 1000;

function isFreshActivationClaim(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() < ACTIVATION_CLAIM_TTL_MS;
}

async function getSourceSigner(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
  expectedAddress: string;
}) {
  const signer = await solanaServices.createOrgSigner(
    input.env,
    input.organizationId,
    input.projectId,
    input.sourceWalletId
  );

  if (signer.address !== input.expectedAddress) {
    throw new AppError("BAD_REQUEST", "Resolved signing wallet does not match source wallet");
  }

  return signer;
}

async function resolveSourceWalletForExecution(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
}): Promise<CustodyWallet> {
  const signingService = createSigningService(input.env);
  const wallets = await signingService.getWalletsWithProviders(
    input.organizationId,
    input.projectId,
    { includeAllProviders: true }
  );
  const wallet = wallets.find((entry) => entry.walletId === input.sourceWalletId);

  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found. Provision wallets through /v1/wallets");
  }

  return wallet;
}

async function createTransferRecord(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  status: PaymentTransferStatus;
  initiatedByKeyId?: string | null;
}) {
  const now = new Date().toISOString();
  const transfer = await createPaymentsRepository(input.env).createTransfer({
    id: `xfr_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    walletId: input.recurringPayment.source_wallet_id,
    sourceAddress: input.recurringPayment.source_address,
    destinationAddress: input.recurringPayment.destination_address,
    token: input.recurringPayment.token,
    amount: input.recurringPayment.amount,
    memo: null,
    type: "transfer",
    direction: "outbound",
    status: input.status,
    serializedTx: null,
    initiatedByKeyId: input.initiatedByKeyId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (!transfer) {
    throw new AppError("INTERNAL_ERROR", "Failed to create payment transfer record");
  }

  return transfer;
}

async function claimActivationRecords(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  destinationTokenAccount: string;
  subscriberTokenAccount: string;
}): Promise<
  | {
      alreadyActive: true;
      recurringPayment: PaymentRecurringPaymentRow;
      plan?: never;
      subscription?: never;
    }
  | {
      alreadyActive: false;
      recurringPayment: PaymentRecurringPaymentRow;
      plan: PaymentSubscriptionPlanRow;
      subscription: PaymentSubscriptionRow;
    }
> {
  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    await tx
      .prepare(
        `SELECT id
           FROM payment_recurring_payments
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
          FOR UPDATE`
      )
      .bind(input.recurringPaymentId, input.organizationId, input.projectId)
      .first();

    const recurringPayment = await txRecurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPaymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });

    if (!recurringPayment) {
      throw new AppError("NOT_FOUND", "Recurring payment not found");
    }
    if (recurringPayment.status === "active") {
      return { alreadyActive: true, recurringPayment };
    }
    if (
      recurringPayment.status === "activating" &&
      isFreshActivationClaim(recurringPayment.updated_at)
    ) {
      throw new AppError("CONFLICT", "Recurring payment activation is already in progress");
    }
    if (
      recurringPayment.status !== "pending_activation" &&
      recurringPayment.status !== "activating"
    ) {
      throw new AppError(
        "BAD_REQUEST",
        "Recurring payment cannot be activated from its current status"
      );
    }

    const now = new Date().toISOString();
    let plan = recurringPayment.plan_id
      ? await txSubscriptionsRepo.getPlanById({
          planId: recurringPayment.plan_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;

    if (!plan) {
      plan = await txSubscriptionsRepo.createPlan({
        id: `psp_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ownerWalletId: recurringPayment.source_wallet_id,
        ownerAddress: recurringPayment.source_address,
        token: recurringPayment.token,
        amount: recurringPayment.amount,
        periodHours: recurringPayment.period_hours,
        programPlanId: generateProgramPlanId(),
        planPda: null,
        destinationAddress: input.destinationTokenAccount,
        pullerWalletId: recurringPayment.source_wallet_id,
        pullerAddress: recurringPayment.source_address,
        metadataUri: recurringPayment.metadata_uri,
        status: "draft",
        createdBy: recurringPayment.created_by,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!plan) {
      throw new AppError("INTERNAL_ERROR", "Failed to create subscription plan");
    }

    let subscription = recurringPayment.subscription_id
      ? await txSubscriptionsRepo.getSubscriptionById({
          subscriptionId: recurringPayment.subscription_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;

    if (!subscription) {
      subscription = await txSubscriptionsRepo.createSubscription({
        id: `psub_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planId: plan.id,
        counterpartyId: recurringPayment.counterparty_id,
        subscriberAddress: recurringPayment.source_address,
        subscriberTokenAccount: input.subscriberTokenAccount,
        subscriptionPda: null,
        subscriptionAuthorityAddress: null,
        authorizationSignature: null,
        status: "pending_authorization",
        currentPeriodStartAt: null,
        nextCollectionDueAt: null,
        createdBy: recurringPayment.created_by,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!subscription) {
      throw new AppError("INTERNAL_ERROR", "Failed to create subscription");
    }

    const claimedPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      destinationTokenAccount: input.destinationTokenAccount,
      planId: plan.id,
      subscriptionId: subscription.id,
      status: "activating",
      updatedAt: now,
    });

    if (!claimedPayment) {
      throw new AppError("INTERNAL_ERROR", "Failed to claim recurring payment activation");
    }

    return {
      alreadyActive: false,
      recurringPayment: claimedPayment,
      plan,
      subscription,
    };
  });
}

async function updateTransferRecord(input: {
  env: Env;
  transferId: string;
  status?: PaymentTransferStatus;
  signature?: string | null;
  slot?: number | null;
  blockTime?: string | null;
  error?: string | null;
}) {
  const updated = await createPaymentsRepository(input.env).updateTransfer({
    transferId: input.transferId,
    status: input.status,
    signature: input.signature,
    slot: input.slot,
    blockTime: input.blockTime,
    error: input.error,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw new AppError("INTERNAL_ERROR", "Payment transfer record not found for update");
  }

  return updated;
}

export async function createRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  counterpartyId: string;
  counterpartyAccountId: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt?: string | null;
  metadataUri?: string | null;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  assertSubscriptionTokenMint(input.token);

  const destination = await resolveSolanaCounterpartyAccount({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
  });
  await assertWalletPolicyAllowsTransferWithRepository(createPaymentsRepository(input.env), {
    organizationId: input.organizationId,
    projectId: input.projectId,
    wallet: input.sourceWallet,
    destinationAddress: destination.destinationAddress,
    token: input.token,
    amount: input.amount,
  });

  const now = new Date().toISOString();
  const recurringPayment = await createPaymentRecurringPaymentsRepository(
    input.env
  ).createRecurringPayment({
    id: `prp_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: input.sourceWallet.walletId,
    sourceAddress: input.sourceWallet.publicKey,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
    destinationAddress: destination.destinationAddress,
    token: input.token,
    amount: input.amount,
    periodHours: input.periodHours,
    firstCollectionAt: input.firstCollectionAt ?? null,
    metadataUri: input.metadataUri ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!recurringPayment) {
    throw new AppError("INTERNAL_ERROR", "Failed to create recurring payment");
  }

  return recurringPayment;
}

export async function activateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
}): Promise<ActivationResult> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  let recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  if (recurringPayment.status === "active") {
    return { recurringPayment };
  }
  if (
    recurringPayment.status !== "pending_activation" &&
    recurringPayment.status !== "activating"
  ) {
    throw new AppError(
      "BAD_REQUEST",
      "Recurring payment cannot be activated from its current status"
    );
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const sourceSigner = await getSourceSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: recurringPayment.source_wallet_id,
    expectedAddress: sourceAddress,
  });
  const runtime = await resolveRecurringSubscriptionRuntime(input.env, recurringPayment);
  const destinationAddress = assertValidAddress(
    recurringPayment.destination_address,
    "destinationAddress"
  );
  const destinationTokenAccount = await deriveAssociatedTokenAccount({
    owner: destinationAddress,
    runtime,
  });

  const activation = await claimActivationRecords({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: recurringPayment.id,
    destinationTokenAccount,
    subscriberTokenAccount: runtime.sourceTokenAccount,
  });

  if (activation.alreadyActive) {
    return { recurringPayment: activation.recurringPayment };
  }

  recurringPayment = activation.recurringPayment;
  const { plan, subscription } = activation;

  const onChainPlan = await ensureSubscriptionPlanOnChain({
    env: input.env,
    sourceSigner,
    sourceAddress,
    destinationTokenAccount,
    programPlanId: plan.program_plan_id,
    metadataUri: recurringPayment.metadata_uri ?? "",
    runtime,
    periodHours: recurringPayment.period_hours,
    existingSignature: recurringPayment.plan_creation_signature,
  });

  const onChainAuthorization = await ensureSubscriptionAuthorizationOnChain({
    env: input.env,
    sourceSigner,
    sourceAddress,
    sourceTokenAccount: runtime.sourceTokenAccount,
    planId: onChainPlan.planId,
    planPda: onChainPlan.planPda,
    planCreatedAt: onChainPlan.planCreatedAt,
    runtime,
    periodHours: recurringPayment.period_hours,
    existingSignature:
      recurringPayment.authorization_signature ?? subscription.authorization_signature,
  });
  const dueAt = recurringPayment.first_collection_at ?? new Date().toISOString();
  const claimedRecurringPayment = recurringPayment;
  recurringPayment = await getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updatedAt = new Date().toISOString();
    const updatedPlan = await txSubscriptionsRepo.updatePlan({
      planId: plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda: onChainPlan.planPda,
      destinationAddress: destinationTokenAccount,
      pullerWalletId: claimedRecurringPayment.source_wallet_id,
      pullerAddress: claimedRecurringPayment.source_address,
      status: "active",
      updatedAt,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriberTokenAccount: runtime.sourceTokenAccount,
      subscriptionPda: onChainAuthorization.subscriptionPda,
      subscriptionAuthorityAddress: onChainAuthorization.subscriptionAuthorityAddress,
      authorizationSignature:
        onChainAuthorization.signature ?? subscription.authorization_signature,
      status: "active",
      currentPeriodStartAt: dueAt,
      nextCollectionDueAt: dueAt,
      updatedAt,
    });
    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: claimedRecurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      destinationTokenAccount,
      nextCollectionDueAt: dueAt,
      planId: plan.id,
      subscriptionId: subscription.id,
      planPda: onChainPlan.planPda,
      planCreatedAt: onChainPlan.planCreatedAt.toString(),
      planCreationSignature:
        onChainPlan.signature ?? claimedRecurringPayment.plan_creation_signature ?? null,
      subscriptionPda: onChainAuthorization.subscriptionPda,
      subscriptionAuthorityAddress: onChainAuthorization.subscriptionAuthorityAddress,
      authorizationSignature:
        onChainAuthorization.signature ??
        claimedRecurringPayment.authorization_signature ??
        subscription.authorization_signature ??
        null,
      status: "active",
      updatedAt,
    });

    if (!updatedPlan || !updatedSubscription || !updatedRecurringPayment) {
      throw new AppError("INTERNAL_ERROR", "Failed to activate subscription records");
    }

    return updatedRecurringPayment;
  });

  return {
    recurringPayment,
    planSignature: onChainPlan.signature,
    authorizationSignature: onChainAuthorization.signature,
  };
}

export async function collectRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  initiatedByKeyId?: string | null;
  enforceDue?: boolean;
  sourceWallet?: CustodyWallet;
}): Promise<CollectionResult> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  if (recurringPayment.status !== "active") {
    throw new AppError("BAD_REQUEST", "Recurring payment must be active before collection");
  }
  if (
    !recurringPayment.subscription_id ||
    !recurringPayment.plan_pda ||
    !recurringPayment.subscription_pda
  ) {
    throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
  }
  if (!recurringPayment.next_collection_due_at) {
    throw new AppError("BAD_REQUEST", "Recurring payment has no due collection");
  }

  const subscriptionId = recurringPayment.subscription_id;
  const dueAt = recurringPayment.next_collection_due_at;
  if (input.enforceDue !== false && new Date(dueAt).getTime() > Date.now()) {
    throw new AppError("BAD_REQUEST", "Recurring payment is not due for collection");
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const destinationAddress = assertValidAddress(
    recurringPayment.destination_address,
    "destinationAddress"
  );
  const sourceWallet =
    input.sourceWallet ??
    (await resolveSourceWalletForExecution({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWalletId: recurringPayment.source_wallet_id,
    }));
  await assertWalletPolicyAllowsTransferWithRepository(createPaymentsRepository(input.env), {
    organizationId: input.organizationId,
    projectId: input.projectId,
    wallet: sourceWallet,
    destinationAddress,
    token: recurringPayment.token,
    amount: recurringPayment.amount,
  });
  const planPda = assertValidAddress(recurringPayment.plan_pda, "planPda");
  const subscriptionPda = assertValidAddress(recurringPayment.subscription_pda, "subscriptionPda");
  const sourceSigner = await getSourceSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: recurringPayment.source_wallet_id,
    expectedAddress: sourceAddress,
  });
  const runtime = await resolveRecurringSubscriptionRuntime(input.env, recurringPayment);
  let attempt = await subscriptionsRepo.getCollectionAttemptByRecurringDue({
    recurringPaymentId: recurringPayment.id,
    dueAt,
  });

  if (attempt && ["pending", "processing", "confirmed"].includes(attempt.status)) {
    throw new AppError("CONFLICT", "Collection attempt already exists for this due time");
  }

  const now = new Date().toISOString();
  try {
    attempt = await subscriptionsRepo.createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: recurringPayment.subscription_id,
      recurringPaymentId: recurringPayment.id,
      transferId: null,
      token: recurringPayment.token,
      amount: recurringPayment.amount,
      dueAt,
      attemptedAt: now,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    attempt = await subscriptionsRepo.getCollectionAttemptByRecurringDue({
      recurringPaymentId: recurringPayment.id,
      dueAt,
    });
    if (attempt && ["pending", "processing", "confirmed"].includes(attempt.status)) {
      throw new AppError("CONFLICT", "Collection attempt already exists for this due time");
    }
    throw error;
  }

  if (!attempt) {
    throw new AppError("INTERNAL_ERROR", "Failed to create collection attempt");
  }

  const attemptId = attempt.id;
  let transfer: PaymentTransferRow | null = null;
  try {
    transfer = await createTransferRecord({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      status: "processing",
      initiatedByKeyId: input.initiatedByKeyId ?? null,
    });
    attempt = await subscriptionsRepo.updateCollectionAttempt({
      attemptId,
      transferId: transfer.id,
      status: "processing",
      attemptedAt: now,
      updatedAt: new Date().toISOString(),
    });
    if (!attempt) {
      throw new AppError("INTERNAL_ERROR", "Failed to update collection attempt");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await subscriptionsRepo.updateCollectionAttempt({
      attemptId,
      transferId: transfer?.id,
      status: "failed",
      error: message,
      attemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (transfer) {
      await updateTransferRecord({
        env: input.env,
        transferId: transfer.id,
        status: "failed",
        error: message,
      });
    }
    throw error;
  }
  if (!transfer) {
    throw new AppError("INTERNAL_ERROR", "Failed to create payment transfer record");
  }

  let executed: Awaited<ReturnType<typeof collectSubscriptionOnChain>>;
  try {
    executed = await collectSubscriptionOnChain({
      env: input.env,
      sourceSigner,
      sourceAddress,
      destinationAddress,
      planPda,
      subscriptionPda,
      runtime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateTransferRecord({
      env: input.env,
      transferId: transfer.id,
      status: "failed",
      error: message,
    });
    const failedAttempt = await subscriptionsRepo.updateCollectionAttempt({
      attemptId: attempt.id,
      transferId: transfer.id,
      status: "failed",
      error: message,
      attemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (failedAttempt) {
      attempt = failedAttempt;
    }

    throw error;
  }

  const nextDueAt = addPeriodHours(dueAt, recurringPayment.period_hours);
  return getDb(input.env).transaction(async (tx) => {
    const txPaymentsRepo = createPostgresPaymentsRepository(tx);
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updatedAt = new Date().toISOString();
    const updatedTransfer = await txPaymentsRepo.updateTransfer({
      transferId: transfer.id,
      status: "confirmed",
      signature: executed.signature,
      slot: executed.slot,
      blockTime: executed.blockTime,
      error: null,
      updatedAt,
    });
    const updatedAttempt = await txSubscriptionsRepo.updateCollectionAttempt({
      attemptId: attempt.id,
      transferId: transfer.id,
      status: "confirmed",
      signature: executed.signature,
      attemptedAt: updatedAt,
      updatedAt,
    });
    const updatedRecurringPayment = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      destinationTokenAccount: executed.destinationTokenAccount,
      nextCollectionDueAt: nextDueAt,
      updatedAt,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      currentPeriodStartAt: dueAt,
      nextCollectionDueAt: nextDueAt,
      updatedAt,
    });

    if (!updatedTransfer || !updatedAttempt || !updatedRecurringPayment || !updatedSubscription) {
      throw new AppError("INTERNAL_ERROR", "Failed to update recurring payment collection state");
    }

    return {
      recurringPayment: updatedRecurringPayment,
      collectionAttempt: updatedAttempt,
      transfer: updatedTransfer,
    };
  });
}

export async function executeRecurringPaymentLifecycle(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: "cancel" | "resume";
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  const subscriptionId = recurringPayment.subscription_id;
  if (!subscriptionId || !recurringPayment.plan_pda || !recurringPayment.subscription_pda) {
    throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
  }
  if (input.operation === "cancel" && recurringPayment.status !== "active") {
    throw new AppError("BAD_REQUEST", "Only active recurring payments can be canceled");
  }
  if (
    input.operation === "resume" &&
    recurringPayment.status !== "canceled" &&
    recurringPayment.status !== "paused"
  ) {
    throw new AppError("BAD_REQUEST", "Only canceled or paused recurring payments can be resumed");
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const sourceSigner = await getSourceSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: recurringPayment.source_wallet_id,
    expectedAddress: sourceAddress,
  });
  await executeSubscriptionLifecycleOnChain({
    env: input.env,
    operation: input.operation,
    sourceSigner,
    planPda: assertValidAddress(recurringPayment.plan_pda, "planPda"),
    subscriptionPda: assertValidAddress(recurringPayment.subscription_pda, "subscriptionPda"),
  });

  const now = new Date().toISOString();
  const status = input.operation === "cancel" ? "canceled" : "active";

  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updated = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status,
      updatedAt: now,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status,
      canceledAt: input.operation === "cancel" ? now : null,
      updatedAt: now,
    });

    if (!updated || !updatedSubscription) {
      throw new AppError("INTERNAL_ERROR", "Failed to update recurring payment lifecycle state");
    }

    return updated;
  });
}
