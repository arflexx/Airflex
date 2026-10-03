import React from "react";
import { render, waitFor } from "@testing-library/react";
import ServiceWorkerRegister from "./ServiceWorkerRegister";
import { reportError } from "@/app/lib/monitoring";

jest.mock("@/app/lib/monitoring", () => ({
  reportError: jest.fn(),
}));

const mockedReportError = reportError as jest.MockedFunction<typeof reportError>;

const originalNodeEnv = process.env.NODE_ENV;

function setServiceWorker(value: unknown) {
  Object.defineProperty(navigator, "serviceWorker", {
    value,
    configurable: true,
  });
}

function removeServiceWorker() {
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
}

describe("ServiceWorkerRegister", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.NODE_ENV = originalNodeEnv;
    removeServiceWorker();
  });

  it("does not register and does not throw when navigator.serviceWorker is absent", () => {
    removeServiceWorker();

    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();
    expect(mockedReportError).not.toHaveBeenCalled();
  });

  it("warns and reports to monitoring when registration rejects", async () => {
    process.env.NODE_ENV = "production";
    const error = new Error("boom");
    const register = jest.fn().mockRejectedValue(error);
    setServiceWorker({ register });

    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" })
    );
    await waitFor(() =>
      expect(mockedReportError).toHaveBeenCalledWith(error, {
        source: "service-worker",
      })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[pwa] Service worker registration failed:",
      error
    );
  });

  it("does not warn when registration resolves", async () => {
    process.env.NODE_ENV = "production";
    const register = jest.fn().mockResolvedValue({});
    setServiceWorker({ register });

    render(<ServiceWorkerRegister />);

    await waitFor(() => expect(register).toHaveBeenCalled());
    expect(mockedReportError).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs a development explanation when registration is skipped", () => {
    process.env.NODE_ENV = "development";
    setServiceWorker({ register: jest.fn() });

    render(<ServiceWorkerRegister />);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("production-only feature")
    );
    expect(mockedReportError).not.toHaveBeenCalled();
  });
});
