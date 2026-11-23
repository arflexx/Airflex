import {
  ContractError,
  ExpiryTooFarError,
  OfferExpiredError,
  TradeNotFoundError,
  UnauthorizedContractError,
  parseContractError,
} from "./contractErrors";

describe("contract error mapping", () => {
  it("maps Soroban numeric codes to actionable typed errors", () => {
    expect(parseContractError(new Error("Error(Contract, #3)"))).toBeInstanceOf(TradeNotFoundError);
    expect(parseContractError("ContractError(2)")).toBeInstanceOf(UnauthorizedContractError);
  });

  it("maps the marketplace offer expiry codes (#637)", () => {
    expect(parseContractError("Error(Contract, #20)")).toBeInstanceOf(OfferExpiredError);
    expect(parseContractError("Error(Contract, #21)")).toBeInstanceOf(ExpiryTooFarError);
  });

  it("uses a safe typed fallback for unknown codes and unrelated failures", () => {
    const unknown = parseContractError("Error(Contract, #999)");
    expect(unknown).toBeInstanceOf(ContractError);
    expect(unknown?.message).toContain("could not be completed");
    expect(parseContractError(new Error("network unavailable"))).toBeNull();
  });
});
