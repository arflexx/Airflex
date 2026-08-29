/**
 * Deposit amount validation and Paystack script loading (Issue #25).
 *
 * The modal's interactive behaviour is covered by e2e/deposit.spec.ts; this
 * pins the rules that decide whether a request is even attempted, which is
 * where a wrong answer costs the user money or a confusing rejection.
 */

import {
  MIN_DEPOSIT_NAIRA,
  loadPaystackScript,
  validateDepositAmount,
} from "./DepositModal";

describe("validateDepositAmount", () => {
  it("accepts a whole-naira amount at the minimum", () => {
    expect(validateDepositAmount(String(MIN_DEPOSIT_NAIRA))).toBeNull();
  });

  it("accepts an amount with kobo", () => {
    expect(validateDepositAmount("500.50")).toBeNull();
  });

  it("accepts a large amount", () => {
    expect(validateDepositAmount("1000000")).toBeNull();
  });

  it("rejects an empty field", () => {
    expect(validateDepositAmount("")).toMatch(/enter an amount/i);
    expect(validateDepositAmount("   ")).toMatch(/enter an amount/i);
  });

  it("rejects an amount below the minimum", () => {
    expect(validateDepositAmount("99")).toMatch(/minimum deposit/i);
    expect(validateDepositAmount("0")).toMatch(/minimum deposit/i);
  });

  it("rejects letters", () => {
    expect(validateDepositAmount("abc")).toMatch(/valid amount/i);
    expect(validateDepositAmount("100abc")).toMatch(/valid amount/i);
  });

  it("rejects a negative amount", () => {
    expect(validateDepositAmount("-500")).toMatch(/valid amount/i);
  });

  it("rejects notations Number() would silently accept", () => {
    // Number("0x64") is 100 and Number("1e5") is 100000 — both would pass a
    // naive parse, and neither is what a user typed into a naira field.
    expect(validateDepositAmount("0x64")).toMatch(/valid amount/i);
    expect(validateDepositAmount("1e5")).toMatch(/valid amount/i);
  });

  it("rejects more than two decimal places", () => {
    // Kobo is the smallest unit; a third decimal cannot be charged.
    expect(validateDepositAmount("100.123")).toMatch(/valid amount/i);
  });

  it("rejects whitespace inside the number", () => {
    expect(validateDepositAmount("1 000")).toMatch(/valid amount/i);
  });

  it("names the minimum in the message, so the user knows the bar", () => {
    expect(validateDepositAmount("50")).toContain(String(MIN_DEPOSIT_NAIRA));
  });
});

describe("loadPaystackScript", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    delete (window as { PaystackPop?: unknown }).PaystackPop;
  });

  it("resolves immediately when Paystack is already present", async () => {
    (window as { PaystackPop?: unknown }).PaystackPop = function PaystackPop() {};

    await expect(loadPaystackScript()).resolves.toBeUndefined();
    expect(document.querySelector("script")).toBeNull();
  });

  it("injects the script exactly once", async () => {
    const first = loadPaystackScript();
    const script = document.querySelector<HTMLScriptElement>("script");
    expect(script).not.toBeNull();

    // A second call while the first is still loading must reuse that tag
    // rather than racing a duplicate download.
    const second = loadPaystackScript();
    expect(document.querySelectorAll("script")).toHaveLength(1);

    script!.dispatchEvent(new Event("load"));
    script!.onload?.(new Event("load"));

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it("rejects with a readable message when the script fails to load", async () => {
    const pending = loadPaystackScript();
    const script = document.querySelector<HTMLScriptElement>("script")!;

    script.onerror?.(new Event("error"));

    await expect(pending).rejects.toThrow(/could not load the paystack checkout/i);
  });

  it("loads from Paystack's own origin", async () => {
    void loadPaystackScript();
    const script = document.querySelector<HTMLScriptElement>("script")!;

    expect(script.src).toBe("https://js.paystack.co/v2/inline.js");
    expect(script.async).toBe(true);
  });
});
