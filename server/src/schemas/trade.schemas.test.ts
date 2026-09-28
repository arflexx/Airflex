/**
 * trade.schemas.test.ts
 *
 * Unit tests for createTradeSchema, buyTradeSchema, and paginationSchema.
 * Confirms that all valid payloads parse and all known-invalid payloads fail
 * with the right field errors.
 */

import {
  createTradeSchema,
  buyTradeSchema,
  paginationSchema,
} from "./trade.schemas";

// ---------------------------------------------------------------------------
// createTradeSchema
// ---------------------------------------------------------------------------

describe("createTradeSchema", () => {
  const valid = {
    assetType: "MTN_AIRTIME",
    amount: 500,
    expiresInHours: 24,
  };

  it("accepts a valid payload", () => {
    expect(createTradeSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts minimum amount (>0)", () => {
    expect(createTradeSchema.safeParse({ ...valid, amount: 0.01 }).success).toBe(true);
  });

  it("accepts minimum expiresInHours (1)", () => {
    expect(createTradeSchema.safeParse({ ...valid, expiresInHours: 1 }).success).toBe(true);
  });

  it("accepts maximum expiresInHours (168)", () => {
    expect(createTradeSchema.safeParse({ ...valid, expiresInHours: 168 }).success).toBe(true);
  });

  it("accepts alphanumeric assetType with underscores and hyphens", () => {
    expect(
      createTradeSchema.safeParse({ ...valid, assetType: "9MOBILE_DATA-PLAN" }).success
    ).toBe(true);
  });

  it("rejects amount = 0", () => {
    const result = createTradeSchema.safeParse({ ...valid, amount: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("amount");
    }
  });

  it("rejects negative amount", () => {
    const result = createTradeSchema.safeParse({ ...valid, amount: -100 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("amount");
    }
  });

  it("rejects expiresInHours = 0", () => {
    const result = createTradeSchema.safeParse({ ...valid, expiresInHours: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("expiresInHours");
    }
  });

  it("rejects expiresInHours > 168", () => {
    const result = createTradeSchema.safeParse({ ...valid, expiresInHours: 169 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("expiresInHours");
    }
  });

  it("rejects fractional expiresInHours", () => {
    const result = createTradeSchema.safeParse({ ...valid, expiresInHours: 1.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("expiresInHours");
    }
  });

  it("rejects assetType with spaces", () => {
    const result = createTradeSchema.safeParse({ ...valid, assetType: "MTN AIRTIME" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("assetType");
    }
  });

  it("rejects assetType longer than 50 characters", () => {
    const result = createTradeSchema.safeParse({
      ...valid,
      assetType: "A".repeat(51),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("assetType");
    }
  });

  it("rejects empty assetType", () => {
    const result = createTradeSchema.safeParse({ ...valid, assetType: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = createTradeSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("assetType");
      expect(fields).toContain("amount");
      expect(fields).toContain("expiresInHours");
    }
  });
});

// ---------------------------------------------------------------------------
// buyTradeSchema
// ---------------------------------------------------------------------------

describe("buyTradeSchema", () => {
  // A real Soroban invoke envelope is several hundred base64 chars; this
  // stands in for one.
  const validXdr = "AAAAAgAAAAD" + "A".repeat(200) + "=";

  it("accepts a base64 transaction envelope", () => {
    expect(buyTradeSchema.safeParse({ signedXdr: validXdr }).success).toBe(true);
  });

  it("rejects a Stellar secret key pasted in place of an envelope", () => {
    // The whole point of Issue #342: a secret key must never be accepted here.
    // It is base64-shaped but far too short to be an envelope.
    const secretKey = "S" + "A".repeat(55);
    const result = buyTradeSchema.safeParse({ signedXdr: secretKey });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("signedXdr");
    }
  });

  it("rejects a non-base64 payload", () => {
    const result = buyTradeSchema.safeParse({ signedXdr: "not xdr!" + "x".repeat(120) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("signedXdr");
    }
  });

  it("rejects an empty envelope", () => {
    const result = buyTradeSchema.safeParse({ signedXdr: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("signedXdr");
    }
  });

  it("rejects a missing signedXdr", () => {
    const result = buyTradeSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path[0]).toBe("signedXdr");
    }
  });

  it("rejects a buyerSecretKey field outright", () => {
    const result = buyTradeSchema.safeParse({ buyerSecretKey: "S" + "A".repeat(55) });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// paginationSchema
// ---------------------------------------------------------------------------

describe("paginationSchema", () => {
  it("applies defaults when no params are provided", () => {
    const result = paginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it("coerces string page and limit to integers", () => {
    const result = paginationSchema.safeParse({ page: "3", limit: "50" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(50);
    }
  });

  it("rejects page = 0", () => {
    const result = paginationSchema.safeParse({ page: "0" });
    expect(result.success).toBe(false);
  });

  it("rejects limit > 100", () => {
    const result = paginationSchema.safeParse({ limit: "101" });
    expect(result.success).toBe(false);
  });

  it("rejects limit = 0", () => {
    const result = paginationSchema.safeParse({ limit: "0" });
    expect(result.success).toBe(false);
  });
});
