import { render, screen } from "@testing-library/react";
import TradesPage from "./page";

jest.mock("../../components/MarketplaceListings", () => ({
  __esModule: true,
  default: () => { throw new Error("temporary marketplace render failure"); },
}));

jest.mock("next-intl/server", () => ({
  getTranslations: jest.fn(),
}));

describe("TradesPage recovery", () => {
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("catches a MarketplaceListings render error and offers a retry", async () => {
    render(await TradesPage());

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
