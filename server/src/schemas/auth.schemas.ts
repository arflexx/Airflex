import { z } from "zod";

/**
 * Schema for POST /api/v1/auth/request-otp
 *
 * Accepts international E.164-style phone numbers and the common Nigerian
 * local format (0XXXXXXXXXX). Total digits: 10–15.
 */
export const requestOtpSchema = z.object({
  phone: z
    .string({ required_error: "phone is required" })
    .trim()
    .regex(
      /^(?:0\d{10}|\+?[1-9]\d{9,14})$/,
      "Enter a valid phone number (e.g. +2348012345678 or 08012345678)"
    ),
  referralCode: z.string().trim().length(8).regex(/^[A-Za-z0-9]+$/).optional(),
});

export type RequestOtpInput = z.infer<typeof requestOtpSchema>;

// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/v1/auth/verify-otp
 */
export const verifyOtpSchema = z.object({
  phone: z
    .string({ required_error: "phone is required" })
    .trim()
    .min(1, "phone is required"),

  otp: z
    .string({ required_error: "otp is required" })
    .trim()
    .length(6, "OTP must be exactly 6 digits")
    .regex(/^\d{6}$/, "OTP must contain only digits"),
});

export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/v1/auth/recover (issue #108).
 *
 * recoveryCode — a 16-character backup code issued at signup. The alphabet
 * excludes confusable characters, but accept any alphanumeric input and let
 * the redemption logic decide validity (so a wrong alphabet never reveals
 * whether a code exists).
 */
export const recoverSchema = z.object({
  recoveryCode: z
    .string({ required_error: "recoveryCode is required" })
    .trim()
    .length(16, "Recovery code must be exactly 16 characters")
    .regex(/^[A-Za-z0-9]+$/, "Recovery code must contain only letters and digits"),
});

export type RecoverInput = z.infer<typeof recoverSchema>;

// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/v1/auth/recover/change-phone (issue #108).
 *
 * token    — the one-time recovery JWT from POST /api/v1/auth/recover.
 * newPhone — the replacement phone number (E.164 or Nigerian local format).
 */
export const changePhoneSchema = z.object({
  token: z.string({ required_error: "token is required" }).trim().min(1),
  newPhone: z
    .string({ required_error: "newPhone is required" })
    .trim()
    .regex(
      /^(?:0\d{10}|\+?[1-9]\d{9,14})$/,
      "Enter a valid phone number (e.g. +2348012345678 or 08012345678)"
    ),
});

export type ChangePhoneInput = z.infer<typeof changePhoneSchema>;
