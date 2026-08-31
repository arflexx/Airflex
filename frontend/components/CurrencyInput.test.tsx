import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { CurrencyInput } from "./CurrencyInput";

describe("CurrencyInput Component", () => {
  it("renders input prefixed with ₦ symbol and formats thousands separator", () => {
    render(<CurrencyInput value={50000} onChange={jest.fn()} id="test-input" />);

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("50,000");
    expect(screen.getByText("₦")).toBeInTheDocument();
  });

  it("strips non-numeric characters on change and passes plain number to onChange", () => {
    const handleChange = jest.fn();
    render(<CurrencyInput value={0} onChange={handleChange} id="test-input" />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "₦ 50,000abc" } });

    expect(handleChange).toHaveBeenCalledWith(50000);
  });

  it("displays inline red error message when value is below min", () => {
    render(<CurrencyInput value={50} onChange={jest.fn()} min={100} id="test-input" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Minimum amount is ₦100");
  });

  it("increments and decrements in steps of 100 on arrow key presses", () => {
    const handleChange = jest.fn();
    render(<CurrencyInput value={500} onChange={handleChange} id="test-input" />);

    const input = screen.getByRole("textbox");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(handleChange).toHaveBeenCalledWith(600);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(handleChange).toHaveBeenCalledWith(400);
  });
});
