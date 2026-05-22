import { COUNTERPARTY_ID_TYPES } from "@sdp/types";
import {
  counterpartyEntityTypeSchema,
  counterpartyIdentitySchema,
  createCounterpartySchema as createCounterpartySchemaBase,
} from "../../routes/counterparties/schemas";
import {
  isoDateTimeSchema,
  orgIdParamSchema,
  projectIdParamSchema,
  userIdSchema,
  withOpenApi,
  z,
} from "./base";

const counterpartyIdParamSchema = z
  .string()
  .min(1)
  .openapi({ description: "Counterparty identifier.", example: "cpt_example" });

const counterpartyAddressSchema = z
  .object({
    line1: z.string().openapi({ description: "Street address line 1.", example: "1 Main St" }),
    line2: z
      .string()
      .optional()
      .openapi({ description: "Street address line 2.", example: "Apt 4B" }),
    city: z.string().openapi({ description: "City.", example: "San Francisco" }),
    postalCode: z.string().optional().openapi({ description: "Postal code.", example: "94110" }),
    countryCode: z
      .string()
      .openapi({ description: "ISO 3166-1 alpha-2 country code.", example: "US" }),
    subdivisionCode: z
      .string()
      .optional()
      .openapi({ description: "ISO 3166-2 subdivision code.", example: "US-CA" }),
  })
  .openapi({ description: "Counterparty postal address." });

const counterpartyGovernmentIdSchema = z
  .object({
    type: z.enum(COUNTERPARTY_ID_TYPES).openapi({
      description: "Government-ID type. PAS=passport, DRV=driver license, STA=state ID, GOV=other.",
      example: "PAS",
    }),
    number: z.string().openapi({ description: "Document number.", example: "A1234567" }),
    issueCountry: z
      .string()
      .openapi({ description: "ISO 3166-1 alpha-2 issuing country.", example: "US" }),
    subdivisionCode: z.string().optional().openapi({
      description: "ISO 3166-2 issuing subdivision.",
      example: "US-CA",
    }),
    issueDate: z
      .string()
      .optional()
      .openapi({ description: "Issue date (ISO 8601).", example: "2020-01-01" }),
    expiryDate: z
      .string()
      .optional()
      .openapi({ description: "Expiry date (ISO 8601).", example: "2030-01-01" }),
  })
  .openapi({ description: "Counterparty government-issued identification." });

const counterpartyIdentityOpenApiSchema = z
  .object({
    firstName: z.string().optional().openapi({ description: "First name.", example: "Ada" }),
    middleName: z.string().optional().openapi({ description: "Middle name.", example: "K." }),
    lastName: z.string().optional().openapi({ description: "Last name.", example: "Lovelace" }),
    secondLastName: z
      .string()
      .optional()
      .openapi({ description: "Second last name (where applicable).", example: "King" }),
    dateOfBirth: z
      .string()
      .optional()
      .openapi({ description: "Date of birth (ISO 8601).", example: "1815-12-10" }),
    phone: z
      .string()
      .optional()
      .openapi({ description: "Phone number in E.164 format.", example: "+14155551212" }),
    address: counterpartyAddressSchema.optional(),
    birthCountryCode: z
      .string()
      .optional()
      .openapi({ description: "ISO 3166-1 alpha-2 birth country.", example: "GB" }),
    citizenshipCountryCode: z
      .string()
      .optional()
      .openapi({ description: "ISO 3166-1 alpha-2 citizenship country.", example: "GB" }),
    governmentId: counterpartyGovernmentIdSchema.optional(),
  })
  .openapi({
    description:
      "Counterparty identity record. Provider-extensible — additional fields are accepted and forwarded.",
  });

export const counterpartySchema = z
  .object({
    id: counterpartyIdParamSchema,
    organizationId: orgIdParamSchema,
    projectId: projectIdParamSchema,
    externalId: z
      .string()
      .nullable()
      .openapi({
        description: "External identifier supplied by the integrator.",
        example: "customer_12345",
      }),
    entityType: counterpartyEntityTypeSchema.openapi({
      description: "Counterparty entity type.",
      example: "individual",
    }),
    displayName: z
      .string()
      .openapi({ description: "Display name for the counterparty.", example: "Ada Lovelace" }),
    email: z
      .string()
      .openapi({ description: "Contact email.", example: "ada@example.com" }),
    identity: counterpartyIdentityOpenApiSchema,
    isActive: z
      .boolean()
      .openapi({ description: "Whether the counterparty is active.", example: true }),
    createdBy: userIdSchema
      .nullable()
      .openapi({ description: "User who created the counterparty (if resolvable)." }),
    createdAt: isoDateTimeSchema.openapi({ description: "Creation timestamp." }),
    updatedAt: isoDateTimeSchema.openapi({ description: "Last update timestamp." }),
  })
  .openapi({ description: "Counterparty record." });

export const counterpartyResponseSchema = z
  .object({
    counterparty: counterpartySchema,
  })
  .openapi({ description: "Counterparty response payload." });

export const createCounterpartyRequestSchema = createCounterpartySchemaBase
  .extend({
    externalId: withOpenApi(createCounterpartySchemaBase.shape.externalId, {
      description: "Optional external identifier supplied by the integrator.",
      example: "customer_12345",
    }),
    entityType: withOpenApi(createCounterpartySchemaBase.shape.entityType, {
      description: "Counterparty entity type.",
      example: "individual",
    }),
    displayName: withOpenApi(createCounterpartySchemaBase.shape.displayName, {
      description: "Display name for the counterparty.",
      example: "Ada Lovelace",
    }),
    email: withOpenApi(createCounterpartySchemaBase.shape.email, {
      description: "Contact email.",
      example: "ada@example.com",
    }),
    projectId: withOpenApi(createCounterpartySchemaBase.shape.projectId, {
      description:
        "Project identifier. Required for org-scoped API keys; optional for project-scoped keys (uses key's project).",
      example: "prj_example",
    }),
    identity: withOpenApi(createCounterpartySchemaBase.shape.identity, {
      description: "Optional identity payload.",
    }),
  })
  .openapi({ description: "Create counterparty request body." });

// Re-export so the underlying zod schema is accessible without poking into the routes folder.
export { counterpartyIdentitySchema };
