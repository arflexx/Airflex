import { z } from "zod";

/**
 * Schema for POST /api/auth/request-otp
 *
 * Accepts international E.164-style phone numbers and the common Nigerian
 * local format (0XXXXXXXXXX). Total digits: 10–15.
 */
export const requestOtpSchema = z.object({
  phone: z
    .string({ required_error: "phone is required" })
    .trim()
    .regex(
      /^(?:\+?[1-9]\d{9,14}|0[7-9]\d{9})$/,
      "Enter a valid phone number (e.g. +2348012345678 or 08012345678)"
    ),
});

export type RequestOtpInput = z.infer<typeof requestOtpSchema>;

// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/auth/verify-otp
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
