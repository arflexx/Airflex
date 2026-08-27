/**
 * crypto.test.ts
 *
 * Unit tests for the crypto utilities (encrypt/decrypt with AES-256-GCM)
 */

import { encrypt, decrypt } from "./crypto";

describe("crypto utils", () => {
  const originalEnv = process.env["ENCRYPTION_KEY"];

  beforeEach(() => {
    process.env["ENCRYPTION_KEY"] =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  });

  beforeAll(() => {
    // Set a valid 64-char hex key for testing
    process.env["ENCRYPTION_KEY"] =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
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
    });
  });

  describe("decrypt", () => {
    it("decrypts what encrypt produces (round-trip)", () => {
      process.env["ENCRYPTION_KEY"] =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
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
});
