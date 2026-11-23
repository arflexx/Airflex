import crypto from "crypto";
import { encrypt, decrypt, verifyPaystackSignature } from "./crypto";

const VALID_KEY = crypto.randomBytes(32).toString("hex");

beforeEach(() => {
  process.env["ENCRYPTION_KEY"] = VALID_KEY;
});

afterEach(() => {
  delete process.env["ENCRYPTION_KEY"];
});

describe("encrypt / decrypt — AES-256-GCM roundtrip", () => {
  it("decrypts back to the original plaintext", () => {
    const plaintext = "hello world";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const c1 = encrypt("same");
    const c2 = encrypt("same");
    expect(c1).not.toBe(c2);
  });

  it("roundtrips an empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("roundtrips a unicode string", () => {
    const text = "naïve café 🚀";
    expect(decrypt(encrypt(text))).toBe(text);
  });
});

describe("encrypt — wrong or missing key", () => {
  it("throws when ENCRYPTION_KEY is missing", () => {
    delete process.env["ENCRYPTION_KEY"];
    expect(() => encrypt("x")).toThrow("ENCRYPTION_KEY must be 32 bytes");
  });

  it("throws when ENCRYPTION_KEY is the wrong length", () => {
    process.env["ENCRYPTION_KEY"] = "tooshort";
    expect(() => encrypt("x")).toThrow("ENCRYPTION_KEY must be 32 bytes");
  });
});

describe("decrypt — wrong-key failure", () => {
  it("throws when decrypting with a different key", () => {
    const ciphertext = encrypt("secret");
    // Switch to a different valid key
    process.env["ENCRYPTION_KEY"] = crypto.randomBytes(32).toString("hex");
    expect(() => decrypt(ciphertext)).toThrow();
  });

  it("throws on a malformed ciphertext (missing segments)", () => {
    expect(() => decrypt("notvalid")).toThrow("Invalid ciphertext format");
  });

  it("throws when ENCRYPTION_KEY is missing during decrypt", () => {
    const ciphertext = encrypt("secret");
    delete process.env["ENCRYPTION_KEY"];
    expect(() => decrypt(ciphertext)).toThrow("ENCRYPTION_KEY must be 32 bytes");
  });
});

describe("verifyPaystackSignature — HMAC-SHA512", () => {
  const secret = "paystack-secret";
  const body = Buffer.from(JSON.stringify({ event: "charge.success" }));
  const signature = crypto.createHmac("sha512", secret).update(body).digest("hex");

  it("returns true for a valid signature (Buffer body)", () => {
    expect(verifyPaystackSignature(body, signature, secret)).toBe(true);
  });

  it("returns true for a valid signature (string body)", () => {
    const strBody = body.toString("utf8");
    const strSig = crypto.createHmac("sha512", secret).update(strBody, "utf8").digest("hex");
    expect(verifyPaystackSignature(strBody, strSig, secret)).toBe(true);
  });

  it("returns false for a tampered signature", () => {
    expect(verifyPaystackSignature(body, "badsig", secret)).toBe(false);
  });

  it("returns false when body is undefined", () => {
    expect(verifyPaystackSignature(undefined, signature, secret)).toBe(false);
  });

  it("returns false when signature is undefined", () => {
    expect(verifyPaystackSignature(body, undefined, secret)).toBe(false);
  });

  it("returns false when secret is undefined", () => {
    expect(verifyPaystackSignature(body, signature, undefined)).toBe(false);
  });
});
