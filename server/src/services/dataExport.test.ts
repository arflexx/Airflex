jest.mock("../db", () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

import { signDownload, verifyDownloadSignature, EXPORT_REDACTIONS } from "./dataExport";
import { maskPaymentIdentifier } from "./wallet";

describe("data export (issue #539)", () => {
  const exportId = "11111111-1111-1111-1111-111111111111";
  const userId = "22222222-2222-2222-2222-222222222222";
  const now = 1_800_000_000;

  beforeAll(() => {
    process.env["ENCRYPTION_KEY"] = "0000000000000000000000000000000000000000000000000000000000000000";
  });

  describe("signed download URLs", () => {
    it("accepts a valid, unexpired signature", () => {
      const { expires, signature } = signDownload(exportId, userId, now + 900);
      expect(verifyDownloadSignature(exportId, userId, expires, signature, now)).toBe(true);
    });

    it("rejects an expired link", () => {
      const { expires, signature } = signDownload(exportId, userId, now - 1);
      expect(verifyDownloadSignature(exportId, userId, expires, signature, now)).toBe(false);
    });

    it("rejects a tampered expiry, export id or owner", () => {
      const { expires, signature } = signDownload(exportId, userId, now + 900);
      expect(verifyDownloadSignature(exportId, userId, expires + 3600, signature, now)).toBe(false);
      expect(
        verifyDownloadSignature("33333333-3333-3333-3333-333333333333", userId, expires, signature, now)
      ).toBe(false);
      expect(
        verifyDownloadSignature(exportId, "44444444-4444-4444-4444-444444444444", expires, signature, now)
      ).toBe(false);
    });

    it("rejects a signature scoped to a different user (wrong-user link)", () => {
      const { expires, signature } = signDownload(exportId, userId, now + 900);
      const differentUserId = "44444444-4444-4444-4444-444444444444";
      expect(verifyDownloadSignature(exportId, differentUserId, expires, signature, now)).toBe(false);
    });

    it("rejects garbage signatures without throwing", () => {
      expect(verifyDownloadSignature(exportId, userId, now + 900, "", now)).toBe(false);
      expect(verifyDownloadSignature(exportId, userId, NaN, "abc", now)).toBe(false);
    });
  });

  describe("redaction", () => {
    it("masks payment identifiers to their last digits", () => {
      expect(maskPaymentIdentifier("0123456789")).toBe("******6789");
      expect(maskPaymentIdentifier("12345678901", 3)).toBe("********901");
      expect(maskPaymentIdentifier("123")).toBe("***");
      expect(maskPaymentIdentifier(null)).toBeNull();
    });

    it("documents that the Stellar secret key is never exported", () => {
      expect(EXPORT_REDACTIONS.some((r) => r.field.includes("stellar_secret_key") && r.treatment === "omitted")).toBe(true);
    });
  });
});
