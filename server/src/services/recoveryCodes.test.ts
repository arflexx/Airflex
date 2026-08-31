/**
 * recoveryCodes.test.ts
 *
 * Unit tests for the pure helpers in recoveryCodes.ts (issue #108). Database
 * round-trips are not exercised here — they need a live PostgreSQL instance.
 */

// The module imports the shared pool, which validates DATABASE_URL at load.
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";

import bcrypt from "bcryptjs";
import {
  RECOVERY_CODE_LENGTH,
  generateRecoveryCode,
  hashRecoveryCode,
  recoveryCodeSha256,
} from "./recoveryCodes";

describe("generateRecoveryCode", () => {
  it("returns a 16-character code", () => {
    expect(generateRecoveryCode()).toHaveLength(RECOVERY_CODE_LENGTH);
  });

  it("uses only unambiguous alphanumeric characters", () => {
    // Alphabet excludes 0, O, 1, I, L — confusable characters that are hard
    // to transcribe from a paper backup.
    for (let i = 0; i < 50; i++) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[A-Z2-9]+$/);
      expect(code).not.toMatch(/[01ILO]/);
    }
  });

  it("produces distinct codes across calls", () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(100);
  });
});

describe("recoveryCodeSha256", () => {
  it("is deterministic", () => {
    const code = generateRecoveryCode();
    expect(recoveryCodeSha256(code)).toBe(recoveryCodeSha256(code));
  });

  it("produces a 64-char hex digest (CHAR(64) column shape)", () => {
    expect(recoveryCodeSha256("ABC23456789ABCDE")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different codes", () => {
    expect(recoveryCodeSha256("ABC23456789ABCDE")).not.toBe(
      recoveryCodeSha256("ABC23456789ABCDF")
    );
  });
});

describe("hashRecoveryCode", () => {
  it("round-trips with bcrypt compare", async () => {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(code);
    expect(hash).not.toBe(code);
    expect(await bcrypt.compare(code, hash)).toBe(true);
  });

  it("rejects a different code", async () => {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(code);
    expect(await bcrypt.compare(generateRecoveryCode(), hash)).toBe(false);
  });
});
