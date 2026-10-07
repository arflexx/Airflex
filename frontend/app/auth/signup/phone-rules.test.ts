/**
 * Phone format rules behind the signup field (issue #283).
 *
 * These rules are shared from packages/shared (@airflex/shared/phone) so the
 * client can never drift from the server's requestOtpSchema: the field only
 * rejects what the API would reject.
 */

import {
  E164_PHONE_REGEX,
  NGN_LOCAL_PHONE_REGEX,
  PHONE_INPUT_REGEX,
  isValidPhoneInput,
} from "@airflex/shared/phone";

describe("shared phone rules (issue #283)", () => {
  describe("E164_PHONE_REGEX", () => {
    it("matches a Nigerian E.164 number", () => {
      expect(E164_PHONE_REGEX.test("+2348012345678")).toBe(true);
    });

    it("matches other country codes", () => {
      expect(E164_PHONE_REGEX.test("+15551234567")).toBe(true);
    });

    it("rejects a number without the leading +", () => {
      expect(E164_PHONE_REGEX.test("2348012345678")).toBe(false);
    });

    it("rejects a leading zero after +", () => {
      expect(E164_PHONE_REGEX.test("+0234812345678")).toBe(false);
    });
  });

  describe("NGN_LOCAL_PHONE_REGEX", () => {
    it("matches the local dialling form", () => {
      expect(NGN_LOCAL_PHONE_REGEX.test("08012345678")).toBe(true);
    });

    it("rejects E.164", () => {
      expect(NGN_LOCAL_PHONE_REGEX.test("+2348012345678")).toBe(false);
    });
  });

  describe("isValidPhoneInput", () => {
    it("accepts E.164", () => {
      expect(isValidPhoneInput("+2348012345678")).toBe(true);
    });

    it("accepts the Nigerian local form", () => {
      expect(isValidPhoneInput("08012345678")).toBe(true);
    });

    it("accepts bare international digits (the server prefixes +)", () => {
      expect(PHONE_INPUT_REGEX.test("2348012345678")).toBe(true);
      expect(isValidPhoneInput("2348012345678")).toBe(true);
    });

    it("ignores surrounding whitespace", () => {
      expect(isValidPhoneInput("  +2348012345678  ")).toBe(true);
    });

    it("rejects empty and whitespace-only values", () => {
      expect(isValidPhoneInput("")).toBe(false);
      expect(isValidPhoneInput("   ")).toBe(false);
    });

    it("rejects numbers that are too short", () => {
      expect(isValidPhoneInput("12345")).toBe(false);
    });

    it("rejects numbers longer than 15 digits", () => {
      expect(isValidPhoneInput("1234567890123456")).toBe(false);
    });

    it("rejects letters", () => {
      expect(isValidPhoneInput("notaphone")).toBe(false);
    });

    it("rejects internal whitespace", () => {
      expect(isValidPhoneInput("+234 801 234 5678")).toBe(false);
    });

    it("rejects non-string input", () => {
      expect(isValidPhoneInput(null)).toBe(false);
      expect(isValidPhoneInput(undefined)).toBe(false);
      expect(isValidPhoneInput(2348012345678)).toBe(false);
    });
  });
});
