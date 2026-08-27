import crypto from "crypto";

// AES-256-GCM requires a 32-byte key and 12-byte IV
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * Encrypts a plaintext string using AES-256-GCM with the ENCRYPTION_KEY.
 * Returns ciphertext in format: iv:tag:ciphertext (all base64-encoded)
 */
export function encrypt(plaintext: string): string {
  const key = Buffer.from(process.env["ENCRYPTION_KEY"] ?? "", "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Combine iv:tag:ciphertext as base64 strings
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/**
 * Decrypts a ciphertext string encrypted with encrypt().
 * Expects format: iv:tag:ciphertext (all base64-encoded)
 */
export function decrypt(ciphertext: string): string {
  const key = Buffer.from(process.env["ENCRYPTION_KEY"] ?? "", "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }

  const [ivBase64, tagBase64, encryptedBase64] = ciphertext.split(":");
  if (ivBase64 === undefined || tagBase64 === undefined || encryptedBase64 === undefined) {
    throw new Error("Invalid ciphertext format");
  }

  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(tagBase64, "base64");
  const encrypted = Buffer.from(encryptedBase64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
