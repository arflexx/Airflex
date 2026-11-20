import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { CurrencyInput } from "./CurrencyInput";

expect.extend(toHaveNoViolations);

describe("CurrencyInput Component", () => {
  it("renders input prefixed with ₦ symbol and formats thousands separator", () => {
    render(<CurrencyInput value={50000} onChange={jest.fn()} id="test-input" />);

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("50,000");
    expect(screen.getByText("₦")).toBeInTheDocument();
  });

  it("strips non-numeric characters on change and passes plain number to onChange", () => {
    const handleChange = jest.fn();
    render(<CurrencyInput value={0} onChange={handleChange} id="test-input" />);

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "₦ 50,000abc" } });

    expect(handleChange).toHaveBeenCalledWith(50000);
  });

  it("strips non-numeric characters on paste and passes plain number to onChange", () => {
    const handleChange = jest.fn();
    render(<CurrencyInput value={0} onChange={handleChange} id="test-input" />);

    const input = screen.getByRole("spinbutton");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "1,234.56abc" },
    });

    // "1,234.56abc" → strip non-digits → "123456" → parseInt → 123456
    expect(handleChange).toHaveBeenCalledWith(123456);
  });

  it("displays inline red error message when value is below min", () => {
    render(<CurrencyInput value={50} onChange={jest.fn()} min={100} id="test-input" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Minimum amount is ₦100");
    expect(screen.getByRole("spinbutton")).toHaveClass("border-red-400");
  });

  it("displays inline red error message when value is above max (issue #602)", () => {
    render(<CurrencyInput value={600} onChange={jest.fn()} max={500} id="test-input" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Maximum amount is ₦500");
    const input = screen.getByRole("spinbutton");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "test-input-error");
    expect(input).toHaveClass("border-red-400");
  });

  it("shows no error and a plain border for an empty value (issue #602)", () => {
    render(<CurrencyInput value="" onChange={jest.fn()} min={100} max={500} id="test-input" />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const input = screen.getByRole("spinbutton");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveValue("");
  });

  it("shows no error for a valid in-range value (issue #602)", () => {
    render(<CurrencyInput value={250} onChange={jest.fn()} min={100} max={500} id="test-input" />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).not.toHaveAttribute("aria-invalid");
  });

  it("accepts a decimalPlaces prop and flags values with too many decimals (issue #602)", () => {
    render(
      <CurrencyInput value={"12.567"} onChange={jest.fn()} decimalPlaces={2} id="test-input" />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Enter up to 2 decimal places");
  });

  it("accepts a decimal value within the configured decimalPlaces without error (issue #602)", () => {
    render(
      <CurrencyInput value={"12.56"} onChange={jest.fn()} decimalPlaces={2} id="test-input" />
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue("12.56");
  });

  it("increments and decrements in steps of 100 on arrow key presses", () => {
    const handleChange = jest.fn();
    render(<CurrencyInput value={500} onChange={handleChange} id="test-input" />);

    const input = screen.getByRole("spinbutton");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(handleChange).toHaveBeenCalledWith(600);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(handleChange).toHaveBeenCalledWith(400);
  });

  it("exposes its name, bounds, current value, and announced validation", async () => {
    const { container } = render(
      <CurrencyInput value={50} min={100} max={500} onChange={jest.fn()} id="accessible-amount" />
    );
    const input = screen.getByRole("spinbutton", { name: "Amount in Nigerian naira" });

    expect(input).toHaveAttribute("aria-valuemin", "100");
    expect(input).toHaveAttribute("aria-valuemax", "500");
    expect(input).toHaveAttribute("aria-valuenow", "50");
    expect(input).toHaveAttribute("aria-valuetext", "₦50");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("CurrencyInput available-amount caption (#447)", () => {
  it("renders the available balance caption when availableAmount is provided", () => {
    render(<CurrencyInput value={0} onChange={jest.fn()} id="amt" availableAmount="7,500.00" />);
    const caption = screen.getByTestId("currency-input-available");
    expect(caption).toHaveTextContent("Available: ₦7,500.00");
  });

  it("omits the caption when availableAmount is not provided", () => {
    render(<CurrencyInput value={0} onChange={jest.fn()} id="amt" />);
    expect(screen.queryByTestId("currency-input-available")).not.toBeInTheDocument();
  });
});
