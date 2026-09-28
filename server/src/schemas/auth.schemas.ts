import { z } from "zod";
import { normalizePhone } from "../utils/phone";

/**
 * Schema for POST /api/v1/auth/request-otp
 *
 * Accepts international E.164-style phone numbers and the common Nigerian
 * local format (0XXXXXXXXXX). Total digits: 10–15.
 *
 * `phone` is normalised to E.164 (via `normalizePhone`) after the format
 * regex passes, so "08012345678" and "+2348012345678" — the same physical
 * number — always resolve to the same string. Without this, the two forms
 * were stored/looked-up as different `phone` values, letting the same number
 * register a second account (the `users.phone` unique constraint never
 * caught it because the strings genuinely differed).
 */
export const requestOtpSchema = z.object({
  phone: z
    .string({ required_error: "phone is required" })
    .trim()
    .regex(
      /^(?:0\d{10}|\+?[1-9]\d{9,14})$/,
      "Enter a valid phone number (e.g. +2348012345678 or 08012345678)"
    )
    .transform(normalizePhone),
  referralCode: z.string().trim().length(8).regex(/^[A-Za-z0-9]+$/).optional(),
});

export type RequestOtpInput = z.infer<typeof requestOtpSchema>;

// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/v1/auth/verify-otp
 *
 * `phone` is normalised the same way as requestOtpSchema so a caller who
 * requested an OTP as "08012345678" can verify it typing "+2348012345678"
 * (or vice versa) and still match the row created by request-otp. This
 * schema doesn't enforce the stricter format regex (older/looser callers may
 * hit this endpoint directly) — normalizePhone degrades gracefully to a
 * trimmed pass-through for anything it doesn't recognise.
 */
export const verifyOtpSchema = z.object({
  phone: z
    .string({ required_error: "phone is required" })
    .trim()
    .min(1, "phone is required")
    .transform(normalizePhone),

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
 *            Normalised to E.164 for the same reason as requestOtpSchema.
 */
export const changePhoneSchema = z.object({
  token: z.string({ required_error: "token is required" }).trim().min(1),
  newPhone: z
    .string({ required_error: "newPhone is required" })
    .trim()
    .regex(
      /^(?:0\d{10}|\+?[1-9]\d{9,14})$/,
      "Enter a valid phone number (e.g. +2348012345678 or 08012345678)"
    )
    .transform(normalizePhone),
});

export type ChangePhoneInput = z.infer<typeof changePhoneSchema>;
