/**
 * auth.schemas.test.ts
 *
 * Unit tests for requestOtpSchema and verifyOtpSchema.
 */

import {
  requestOtpSchema,
  verifyOtpSchema,
  recoverSchema,
  changePhoneSchema,
} from "./auth.schemas";

// ---------------------------------------------------------------------------
// requestOtpSchema
// ---------------------------------------------------------------------------

describe("requestOtpSchema", () => {
  it("accepts an international E.164 number", () => {
    expect(requestOtpSchema.safeParse({ phone: "+2348012345678" }).success).toBe(true);
  });

  it("accepts a Nigerian local number (0XXXXXXXXXX)", () => {
    expect(requestOtpSchema.safeParse({ phone: "08012345678" }).success).toBe(true);
  });

  it("trims leading and trailing whitespace", () => {
    const result = requestOtpSchema.safeParse({ phone: "  +2348012345678  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe("+2348012345678");
    }
  });

  it("rejects an empty string", () => {
    expect(requestOtpSchema.safeParse({ phone: "" }).success).toBe(false);
  });

  it("rejects a phone number that is too short (fewer than 10 digits)", () => {
    expect(requestOtpSchema.safeParse({ phone: "12345" }).success).toBe(false);
  });

  it("rejects a phone number that is too long (more than 15 digits)", () => {
    expect(requestOtpSchema.safeParse({ phone: "1234567890123456" }).success).toBe(false);
  });

  it("rejects a number starting with 0 after the +", () => {
    // +0... violates E.164 (country codes don't start with 0)
    expect(requestOtpSchema.safeParse({ phone: "+0234812345678" }).success).toBe(false);
  });

  it("rejects alphabetic input", () => {
    expect(requestOtpSchema.safeParse({ phone: "notaphone" }).success).toBe(false);
  });

  it("rejects a missing phone field", () => {
    const result = requestOtpSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("phone");
    }
  });
});

// ---------------------------------------------------------------------------
// verifyOtpSchema
// ---------------------------------------------------------------------------

describe("verifyOtpSchema", () => {
  const valid = { phone: "+2348012345678", otp: "123456" };

  it("accepts a valid phone and 6-digit OTP", () => {
    expect(verifyOtpSchema.safeParse(valid).success).toBe(true);
  });

  it("trims whitespace from both fields", () => {
    const result = verifyOtpSchema.safeParse({
      phone: "  +2348012345678  ",
      otp: "  123456  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe("+2348012345678");
      expect(result.data.otp).toBe("123456");
    }
  });

  it("rejects an OTP shorter than 6 digits", () => {
    const result = verifyOtpSchema.safeParse({ ...valid, otp: "12345" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("otp");
    }
  });

  it("rejects an OTP longer than 6 digits", () => {
    const result = verifyOtpSchema.safeParse({ ...valid, otp: "1234567" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("otp");
    }
  });

  it("rejects a non-numeric OTP", () => {
    const result = verifyOtpSchema.safeParse({ ...valid, otp: "abc123" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("otp");
    }
  });

  it("rejects an empty OTP", () => {
    const result = verifyOtpSchema.safeParse({ ...valid, otp: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing phone field", () => {
    const result = verifyOtpSchema.safeParse({ otp: "123456" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("phone");
    }
  });

  it("rejects a missing otp field", () => {
    const result = verifyOtpSchema.safeParse({ phone: "+2348012345678" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("otp");
    }
  });
});

// ---------------------------------------------------------------------------
// recoverSchema (issue #108)
// ---------------------------------------------------------------------------

describe("recoverSchema", () => {
  it("accepts a 16-character alphanumeric code", () => {
    expect(recoverSchema.safeParse({ recoveryCode: "ABC23456789ABCDE" }).success).toBe(true);
  });

  it("trims whitespace", () => {
    const result = recoverSchema.safeParse({ recoveryCode: "  ABC23456789ABCDE  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recoveryCode).toBe("ABC23456789ABCDE");
    }
  });

  it("accepts lowercase codes (redemption is case-sensitive at lookup)", () => {
    expect(recoverSchema.safeParse({ recoveryCode: "abc23456789abcde" }).success).toBe(true);
  });

  it("rejects a code shorter than 16 characters", () => {
    expect(recoverSchema.safeParse({ recoveryCode: "ABC234567" }).success).toBe(false);
  });

  it("rejects a code longer than 16 characters", () => {
    expect(recoverSchema.safeParse({ recoveryCode: "ABC23456789ABCDEF" }).success).toBe(false);
  });

  it("rejects codes with special characters", () => {
    expect(recoverSchema.safeParse({ recoveryCode: "ABC23456789ABC!E" }).success).toBe(false);
  });

  it("rejects a missing recoveryCode field", () => {
    const result = recoverSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("recoveryCode");
    }
  });
});

// ---------------------------------------------------------------------------
// changePhoneSchema (issue #108)
// ---------------------------------------------------------------------------

describe("changePhoneSchema", () => {
  const valid = { token: "jwt.token.here", newPhone: "+2348012345678" };

  it("accepts a valid token and new phone", () => {
    expect(changePhoneSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a Nigerian local-format phone", () => {
    expect(
      changePhoneSchema.safeParse({ ...valid, newPhone: "08012345678" }).success
    ).toBe(true);
  });

  it("trims whitespace from both fields", () => {
    const result = changePhoneSchema.safeParse({
      token: "  jwt.token.here  ",
      newPhone: "  +2348012345678  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token).toBe("jwt.token.here");
      expect(result.data.newPhone).toBe("+2348012345678");
    }
  });

  it("rejects an invalid phone number", () => {
    expect(changePhoneSchema.safeParse({ ...valid, newPhone: "not-a-phone" }).success).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(changePhoneSchema.safeParse({ ...valid, token: "" }).success).toBe(false);
  });

  it("rejects a missing newPhone field", () => {
    const result = changePhoneSchema.safeParse({ token: "jwt.token.here" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("newPhone");
    }
  });
});
