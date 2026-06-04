import {
  COUNTERPARTY_ACCOUNT_KINDS,
  COUNTERPARTY_ENTITY_TYPES,
  COUNTERPARTY_ID_TYPES,
} from "@sdp/types";
import { z } from "zod";
import { isAddress } from "@/lib/solana";

// TODO: strict country / subdivision validation deferred — see follow-up ticket
// under PRO-1217. Until then, accept any string and let downstream providers
// reject invalid codes.
const countryCodeSchema = z.string().min(2).max(8);
const subdivisionCodeSchema = z.string().min(1).max(16);

export const counterpartyAddressSchema = z.object({
  line1: z.string().min(1).max(512),
  line2: z.string().max(512).optional(),
  city: z.string().min(1).max(256),
  postalCode: z.string().max(32).optional(),
  countryCode: countryCodeSchema,
  subdivisionCode: subdivisionCodeSchema.optional(),
});

export const counterpartyIdTypeSchema = z.enum(COUNTERPARTY_ID_TYPES);

export const counterpartyGovernmentIdSchema = z.object({
  type: counterpartyIdTypeSchema,
  number: z.string().min(1).max(128),
  issueCountry: countryCodeSchema,
  subdivisionCode: subdivisionCodeSchema.optional(),
  issueDate: z.iso.date().optional(),
  expiryDate: z.iso.date().optional(),
});

export const counterpartyIdentitySchema = z.looseObject({
  firstName: z.string().min(1).max(256).optional(),
  middleName: z.string().max(256).optional(),
  lastName: z.string().min(1).max(256).optional(),
  secondLastName: z.string().max(256).optional(),
  dateOfBirth: z.iso.date().optional(),
  phone: z.string().min(1).max(64).optional(),
  address: counterpartyAddressSchema.optional(),
  birthCountryCode: countryCodeSchema.optional(),
  citizenshipCountryCode: countryCodeSchema.optional(),
  governmentId: counterpartyGovernmentIdSchema.optional(),
});

export const counterpartyEntityTypeSchema = z.enum(COUNTERPARTY_ENTITY_TYPES);

export const counterpartyStatusSchema = z.enum(["active", "archived"]);

export const counterpartyIdSchema = z.string().min(1);

export const counterpartyIdParamsSchema = z.object({
  counterpartyId: counterpartyIdSchema,
});

export const counterpartyAccountIdParamsSchema = counterpartyIdParamsSchema.extend({
  accountId: z.string().min(1),
});

export const createCounterpartySchema = z.object({
  externalId: z.string().min(1).max(256).optional(),
  entityType: counterpartyEntityTypeSchema,
  displayName: z.string().min(1).max(512),
  email: z.email().max(512),
  identity: counterpartyIdentitySchema.optional(),
});

export const updateCounterpartyObjectSchema = z.object({
  externalId: z.string().min(1).max(256).nullable().optional(),
  entityType: counterpartyEntityTypeSchema.optional(),
  displayName: z.string().min(1).max(512).optional(),
  email: z.email().max(512).optional(),
  identity: counterpartyIdentitySchema.optional(),
});

export const updateCounterpartySchema = updateCounterpartyObjectSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one field must be provided" }
);

export const listCounterpartiesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: z.coerce.boolean().default(false),
});

const solanaAddressSchema = z
  .string()
  .trim()
  .refine((value) => value.length >= 32 && value.length <= 44 && isAddress(value), {
    message: "details.address must be a base58 Solana address",
  });

export const counterpartyAccountKindSchema = z.enum(COUNTERPARTY_ACCOUNT_KINDS);

export const cryptoWalletAccountDetailsSchema = z
  .object({
    network: z.literal("solana"),
    address: solanaAddressSchema,
  })
  .catchall(z.unknown());

const accountDetailsSchema = z.record(z.string(), z.unknown());
const createAccountDetailsSchema = accountDetailsSchema.default({});

function requireCryptoWalletDetails(value: {
  accountKind?: string;
  details?: Record<string, unknown>;
}) {
  if (value.accountKind !== "crypto_wallet") {
    return true;
  }

  return cryptoWalletAccountDetailsSchema.safeParse(value.details).success;
}

export const createCounterpartyAccountSchema = z
  .object({
    accountKind: counterpartyAccountKindSchema,
    label: z.string().min(1).max(256).nullable().optional(),
    details: createAccountDetailsSchema,
    providerAccountData: z.record(z.string(), z.unknown()).default({}),
  })
  .refine(requireCryptoWalletDetails, {
    message:
      'crypto_wallet accounts require details.network = "solana" and details.address as a Solana wallet address',
    path: ["details"],
  });

export const updateCounterpartyAccountSchema = z
  .object({
    label: z.string().min(1).max(256).nullable().optional(),
    details: accountDetailsSchema.optional(),
    providerAccountData: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const listCounterpartyAccountsQuerySchema = z.object({
  accountKind: counterpartyAccountKindSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: z.coerce.boolean().default(false),
});
