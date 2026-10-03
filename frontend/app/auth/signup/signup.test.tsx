/**
 * Signup phone field (issue #283).
 *
 * The field must give inline format feedback on blur — before any request is
 * attempted — and the submit button must stay disabled while the number is
 * invalid.
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import SignupPage from "./page";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      createAccount: "Create your account",
      createAccountBody:
        "Enter your phone number and we'll send a 6-digit OTP to verify it.",
      phoneNumber: "Phone number",
      phoneRequired: "Phone number is required.",
      phoneInvalid:
        "Enter a valid phone number (e.g. +2348012345678 or 08012345678).",
      sendOtp: "Send OTP",
      sendingOtp: "Sending OTP…",
      alreadyHaveAccount: "Already have an account?",
      signIn: "Sign in",
    };
    return translations[key] ?? key;
  },
}));

function phoneInput(): HTMLInputElement {
  return screen.getByLabelText("Phone number") as HTMLInputElement;
}

function submitButton(): HTMLElement {
  return screen.getByRole("button", { name: /send otp/i });
}

describe("SignupPage phone validation (issue #283)", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({ error: "nope" }) });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("keeps submit disabled while the number is invalid or empty", () => {
    render(<SignupPage />);

    expect(submitButton()).toBeDisabled();

    fireEvent.change(phoneInput(), { target: { value: "12" } });
    expect(submitButton()).toBeDisabled();
  });

  it("shows the inline format error on blur without touching the network", () => {
    render(<SignupPage />);
    const input = phoneInput();

    fireEvent.change(input, { target: { value: "12" } });

    // Not shown before the field is left.
    expect(screen.queryByText(/valid phone number/i)).not.toBeInTheDocument();

    fireEvent.blur(input);

    expect(screen.getByText(/valid phone number/i)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/valid phone number/i);
    expect(submitButton()).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the required message when an empty field is blurred", () => {
    render(<SignupPage />);

    fireEvent.blur(phoneInput());

    expect(screen.getByText(/phone number is required/i)).toBeInTheDocument();
  });

  it("clears the error and re-enables submit once corrected", () => {
    render(<SignupPage />);
    const input = phoneInput();

    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(screen.getByText(/valid phone number/i)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "+2348012345678" } });

    expect(screen.queryByText(/valid phone number/i)).not.toBeInTheDocument();
    expect(submitButton()).not.toBeDisabled();
  });

  it("accepts the Nigerian local form", () => {
    render(<SignupPage />);
    const input = phoneInput();

    fireEvent.change(input, { target: { value: "08012345678" } });
    fireEvent.blur(input);

    expect(screen.queryByText(/valid phone number/i)).not.toBeInTheDocument();
    expect(submitButton()).not.toBeDisabled();
  });

  it("submits the trimmed number once it is valid", async () => {
    render(<SignupPage />);
    const input = phoneInput();

    fireEvent.change(input, { target: { value: "  +2348012345678  " } });
    fireEvent.blur(input);
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/auth/request-otp");
    expect(JSON.parse(String(init.body))).toEqual({ phone: "+2348012345678" });
  });
});
