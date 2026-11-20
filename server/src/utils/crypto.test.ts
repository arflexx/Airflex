/**
 * crypto.test.ts
 *
 * Unit tests for the crypto utilities (encrypt/decrypt with AES-256-GCM)
 */

import { encrypt, decrypt, verifyPaystackSignature } from "./crypto";
import crypto from "crypto";

describe("crypto utils", () => {
  const originalEnv = process.env["ENCRYPTION_KEY"];

  const VALID_KEY =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

  beforeEach(() => {
    process.env["ENCRYPTION_KEY"] = VALID_KEY;
  });

  afterAll(() => {
    // Restore original env var
    process.env["ENCRYPTION_KEY"] = originalEnv;
  });

  describe("encrypt", () => {
    it("encrypts a string and returns base64-encoded ciphertext", () => {
      const plaintext = "Hello, world!";
      const ciphertext = encrypt(plaintext);

      // Verify output format: iv:tag:ciphertext (3 base64 parts separated by colons)
      const parts = ciphertext.split(":");
      expect(parts).toHaveLength(3);
      expect(parts[0]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // iv base64
      expect(parts[1]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // auth tag base64
      expect(parts[2]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // encrypted data base64
    });

    it("produces different ciphertext on each call (random IV)", () => {
      const plaintext = "Same plaintext";
      const ciphertext1 = encrypt(plaintext);
      const ciphertext2 = encrypt(plaintext);

      expect(ciphertext1).not.toBe(ciphertext2);
    });

    it("throws when ENCRYPTION_KEY is not 64 hex characters", () => {
      process.env["ENCRYPTION_KEY"] = "short-key";
      expect(() => encrypt("test")).toThrow();
      process.env["ENCRYPTION_KEY"] =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    });
  });

  describe("decrypt", () => {
    it("decrypts what encrypt produces (round-trip)", () => {
      const inputs = [
        "Hello, world!",
        "",
        "a".repeat(1000),
        "Special chars: !@#$%^&*()_+-=[]{}|;':\",./<>?",
        "Unicode: 你好世界 🌍",
      ];

      for (const input of inputs) {
        const ciphertext = encrypt(input);
        const decrypted = decrypt(ciphertext);
        expect(decrypted).toBe(input);
      }
    });

    it("throws on invalid ciphertext format", () => {
      expect(() => decrypt("invalid")).toThrow();
      expect(() => decrypt("a:b")).toThrow();
      expect(() => decrypt("a:b:c:d")).toThrow();
    });

    it("throws on wrong key (tampering detection)", () => {
      const key1 =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
      const key2 =
        "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff000102030405060708090a0b0c0d0e0f";

      process.env["ENCRYPTION_KEY"] = key1;
      const ciphertext = encrypt("secret");

      process.env["ENCRYPTION_KEY"] = key2;
      expect(() => decrypt(ciphertext)).toThrow();
    });
  });

  describe("verifyPaystackSignature (issue #623)", () => {
    const secret = "sk_test_paystack_secret_key_12345";
    const body = JSON.stringify({ event: "charge.success", data: { reference: "ref_123" } });
    const validSignature = crypto.createHmac("sha512", secret).update(body).digest("hex");

    it("returns true for a valid signature", () => {
      expect(verifyPaystackSignature(body, validSignature, secret)).toBe(true);
      expect(verifyPaystackSignature(Buffer.from(body), validSignature, secret)).toBe(true);
    });

    it("returns false for a tampered body", () => {
      const tamperedBody = JSON.stringify({ event: "charge.success", data: { reference: "ref_tampered" } });
      expect(verifyPaystackSignature(tamperedBody, validSignature, secret)).toBe(false);
    });

    it("returns false for a missing or invalid header signature", () => {
      expect(verifyPaystackSignature(body, undefined, secret)).toBe(false);
      expect(verifyPaystackSignature(body, "", secret)).toBe(false);
      expect(verifyPaystackSignature(body, "invalid_signature_hex", secret)).toBe(false);
    });

    it("returns false when secret or body is missing", () => {
      expect(verifyPaystackSignature(undefined, validSignature, secret)).toBe(false);
      expect(verifyPaystackSignature(body, validSignature, undefined)).toBe(false);
    });
  });
});
