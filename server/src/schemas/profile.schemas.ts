import { z } from "zod";

/**
 * Zod schema for updating a user's profile.
 * Used on PATCH /api/v1/profile and PUT /api/v1/profile.
 *
 * Supported updatable fields:
 *  - alias: 1-32 chars alphanumeric and underscore
 *  - displayHandle: 1-32 chars handle format (e.g., @airflex_user)
 *  - notificationsEnabled: boolean
 *  - optOutNotifications: boolean
 *  - stellarPublicKey: valid Stellar public key (G... 56 chars)
 *  - virtualAccountNumber: 10-digit NUBAN account number
 *  - virtualBankName: string (max 100 chars)
 *
 * Configured with `.strict()` so unknown/extra fields are rejected during validation.
 */
export const profileUpdateSchema = z
  .object({
    alias: z
      .string()
      .trim()
      .min(1, "alias cannot be empty")
      .max(32, "alias must not exceed 32 characters")
      .regex(/^[a-zA-Z0-9_]+$/, "alias can only contain letters, numbers, and underscores")
      .optional(),
    displayHandle: z
      .string()
      .trim()
      .min(1, "displayHandle cannot be empty")
      .max(32, "displayHandle must not exceed 32 characters")
      .regex(/^@?[a-zA-Z0-9_]+$/, "displayHandle can only contain letters, numbers, and underscores, optionally starting with @")
      .optional(),
    notificationsEnabled: z.boolean().optional(),
    optOutNotifications: z.boolean().optional(),
    stellarPublicKey: z
      .string()
      .trim()
      .regex(/^G[A-Z2-7]{55}$/, "stellarPublicKey must be a valid 56-character Stellar public key")
      .optional(),
    virtualAccountNumber: z
      .string()
      .trim()
      .regex(/^\d{10}$/, "virtualAccountNumber must be a 10-digit account number")
      .optional(),
    virtualBankName: z
      .string()
      .trim()
      .min(1, "virtualBankName cannot be empty")
      .max(100, "virtualBankName must not exceed 100 characters")
      .optional(),
  })
  .strict();

export const updateProfileSchema = profileUpdateSchema;

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/**
 * Schemas for phone number change with OTP re-verification (issue #620 / #629).
 */
export const requestPhoneChangeSchema = z.object({
  phone: z.string().trim().regex(/^(\+?234|0)[789][01]\d{8}$/, "Invalid Nigerian phone number"),
});

export const confirmPhoneChangeSchema = z.object({
  otp: z.string().trim().regex(/^\d{6}$/, "OTP must be a 6-digit code"),
});

export type RequestPhoneChangeInput = z.infer<typeof requestPhoneChangeSchema>;
export type ConfirmPhoneChangeInput = z.infer<typeof confirmPhoneChangeSchema>;
