import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import SellPage from "./page";
import { resetConversionRateCache } from "./ratesCache";

// Mock auth module
jest.mock("../lib/auth", () => ({
  isAuthenticated: () => true,
  getToken: () => "mock-jwt-token",
}));

describe("SellPage Real-Time Fiat to USDC Conversion Preview (Issue #326)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetConversionRateCache();
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches conversion rate on mount and updates conversion preview in real time as amount changes", async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/api/v1/profile")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { kycStatus: "verified" } }),
        });
      }
      if (url.includes("/api/v1/rates")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ rate: 1600 }),
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<SellPage />);

    // Wait for auth & KYC loading to complete
    await waitFor(() => {
      expect(screen.getByLabelText(/Amount/i)).toBeInTheDocument();
    });

    // Check that conversion preview appears with initial 0.00 USDC
    const preview = await screen.findByTestId("conversion-preview");
    expect(preview).toHaveTextContent("≈ 0.00 USDC");

    // Enter amount 1600
    const amountInput = screen.getByLabelText(/Amount/i);
    fireEvent.change(amountInput, { target: { value: "1600" } });

    // Expect preview to update to 1.00 USDC (1600 / 1600 = 1.00)
    expect(screen.getByTestId("conversion-preview")).toHaveTextContent("≈ 1.00 USDC");

    // Enter amount 3200
    fireEvent.change(amountInput, { target: { value: "3200" } });
    expect(screen.getByTestId("conversion-preview")).toHaveTextContent("≈ 2.00 USDC");
  });

  it("hides the conversion preview field when conversion rate is unavailable", async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/api/v1/profile")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { kycStatus: "verified" } }),
        });
      }
      if (url.includes("/api/v1/rates")) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: async () => ({ error: "Rates service unavailable" }),
        });
      }
      return Promise.reject(new Error("Network error"));
    });

    render(<SellPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Amount/i)).toBeInTheDocument();
    });

    // Let any pending promises settle
    await new Promise((r) => setTimeout(r, 100));

    expect(screen.queryByTestId("conversion-preview")).not.toBeInTheDocument();
    expect(screen.queryByText(/≈.*USDC/)).not.toBeInTheDocument();
  });
});
